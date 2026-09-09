// Agent Core — control loop that runs inside Durable Object

import {
  CONSECUTIVE_TASK_WINDOW_MS,
  extractDistillationJson,
  type KnowledgeAction,
  normalizeKnowledgeInput,
  normalizeWorkLogInput,
  type UnifiedServerMemory,
  type WorkLogMode,
} from '../../server-memory-schema';
import {
  type AgentLocale,
  extractDistillationSnapshot,
  formatDistillationPromptInput,
  formatServerMemoryForPrompt,
  getResponseLanguageInstruction,
  getSystemPrompt,
  MEMORY_DISTILLATION_PROMPT,
  shouldBypassDistillation,
} from './prompt';
import type { TerminalContext } from './terminal-context';
import { ToolExecutor } from './tool-executor';
import { AGENT_TOOLS } from './tools';
import type {
  AgentConfig,
  AgentMemoryProvider,
  AgentState,
  AIConfig,
  ChatCompletionResponse,
  ChatMessage,
} from './types';

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 50, // 增加到50次，适应复杂部署任务
  timeout: 300_000, // 增加到5分钟，适应长时间命令（如npm install、build）
};

interface ProgressTracker {
  uniqueCommands: Set<string>;
  recentToolCalls: string[];
  extensionUsed: number;
}

const PROGRESS_CONFIG = {
  baseIterations: 50, // 增加到50次
  maxExtensions: 5, // 增加到5次扩展机会
  extensionSize: 25, // 每次扩展增加25次迭代
  maxTotalIterations: 175, // 最大总迭代次数：50 + 5*25 = 175
  loopDetectionWindow: 7, // 增加到7次，更宽松的循环检测
  repetitionThreshold: 0.7, // 增加到70%，适应部署任务（可能重复执行类似命令）
};

export class AgentCore {
  private state: AgentState = { status: 'idle', messages: [], iteration: 0 };
  private abortController: AbortController = new AbortController();
  private agentConfig: AIConfig | null = null;
  private config: AgentConfig;
  private toolExecutor: ToolExecutor;
  private loopTimeout: ReturnType<typeof setTimeout> | null = null;

  private progress: ProgressTracker = {
    uniqueCommands: new Set(),
    recentToolCalls: [],
    extensionUsed: 0,
  };
  private lastSummaryMessageCount: number = 0;

  // 环境与终端上下文（独立存储，注入到 system prompt 中）
  private environmentContext: string = '';
  private terminalContextSnapshot: string = '';
  private preferredLocale: AgentLocale = 'zh-CN';
  private userTimezone: string = 'UTC';
  private unifiedMemory: UnifiedServerMemory = { workLogs: [], knowledge: [] };
  private distillationInProgress: boolean = false;
  private pendingDistillationSnapshot: ChatMessage[] | null = null;

  constructor(
    private terminalContext: TerminalContext,
    private sendToFrontend: (msg: any) => void,
    private fetchAIConfig: (userId: string) => Promise<AIConfig | null>,
    private execCommand: (
      command: string,
      timeout: number,
      signal?: AbortSignal
    ) => Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>,
    private askConfirmation: (command: string, reason: string) => Promise<boolean>,
    config?: Partial<AgentConfig>,
    private memoryProvider?: AgentMemoryProvider
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.toolExecutor = new ToolExecutor(
      this.terminalContext,
      this.execCommand.bind(this),
      async (command: string, reason: string) => {
        this.pauseTimeout();
        try {
          return await this.askConfirmation(command, reason);
        } finally {
          this.resetTimeout();
        }
      },
      () => this.resetTimeout()
    );
  }

  private getEffectiveMaxIterations(): number {
    return this.config.maxIterations + this.progress.extensionUsed * PROGRESS_CONFIG.extensionSize;
  }

  private recordToolCall(toolName: string, args: any): void {
    const signature =
      toolName === 'execute_command'
        ? `exec:${args.command?.trim()}`
        : `${toolName}:${JSON.stringify(args)}`;

    this.progress.recentToolCalls.push(signature);
    if (this.progress.recentToolCalls.length > PROGRESS_CONFIG.loopDetectionWindow) {
      this.progress.recentToolCalls.shift();
    }

    if (toolName === 'execute_command' && args.command) {
      this.progress.uniqueCommands.add(args.command.trim());
    }
  }

  private evaluateProgress(): { shouldExtend: boolean; reason: string } {
    const { recentToolCalls, uniqueCommands, extensionUsed } = this.progress;
    const { maxExtensions, maxTotalIterations, loopDetectionWindow, repetitionThreshold } =
      PROGRESS_CONFIG;

    if (this.state.iteration >= maxTotalIterations) {
      return { shouldExtend: false, reason: '已达绝对上限' };
    }

    if (extensionUsed >= maxExtensions) {
      return { shouldExtend: false, reason: '延期次数已用完' };
    }

    if (recentToolCalls.length >= loopDetectionWindow) {
      const unique = new Set(recentToolCalls);
      const repetitionRate = 1 - unique.size / recentToolCalls.length;
      if (repetitionRate > repetitionThreshold) {
        return {
          shouldExtend: false,
          reason: `检测到循环：最近 ${loopDetectionWindow} 次调用中 ${Math.round(repetitionRate * 100)}% 是重复的`,
        };
      }
    }

    const uniqueCommandRatio = uniqueCommands.size / Math.max(this.state.iteration, 1);
    if (uniqueCommandRatio < 0.2 && this.state.iteration > 15) {
      // 降低到20%，适应部署任务（可能重复执行类似命令）
      return {
        shouldExtend: false,
        reason: `命令多样性过低：${uniqueCommands.size} 条不同命令 / ${this.state.iteration} 次迭代`,
      };
    }

    return {
      shouldExtend: true,
      reason: `任务仍在推进（${uniqueCommands.size} 条不同命令，无循环迹象）`,
    };
  }

  getStatus(): string {
    return this.state.status;
  }

  async handleAgentStart(
    userId: string,
    userMessage: string,
    locale: AgentLocale = 'zh-CN',
    timezone?: string
  ): Promise<void> {
    this.preferredLocale = locale;
    if (timezone && typeof timezone === 'string' && timezone.length <= 64) {
      this.userTimezone = timezone;
    }
    // Cancel stale timeout from previous loop so it can't abort the new controller
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
      this.loopTimeout = null;
    }

    // 判断是否为新会话（首次启动或状态已重置）
    const isNewSession = this.state.messages.length === 0;
    this.state.status = 'running';
    this.state.iteration = 0;
    this.progress = {
      uniqueCommands: new Set(),
      recentToolCalls: [],
      extensionUsed: 0,
    };
    this.abortController = new AbortController();

    // 1. Fetch user AI config from UserDB
    this.agentConfig = await this.fetchAIConfig(userId);
    if (!this.agentConfig) {
      this.sendToFrontend({
        type: 'agent_frame',
        subType: 'error',
        message: '您尚未配置 AI 接口，请先在设置中配置 Base URL 和 API Key。',
      });
      this.state.status = 'idle';
      return;
    }

    if (isNewSession) {
      if (this.memoryProvider) {
        this.unifiedMemory = await this.memoryProvider.fetchUnifiedMemory().catch(() => ({
          workLogs: [],
          knowledge: [],
        }));
      }
      // 2. 首次启动：采集环境 + 终端上下文（注入 system prompt），用户消息保持干净
      this.terminalContextSnapshot = this.terminalContext.snapshot(200);
      const envSnapshot = await this.toolExecutor
        .execute('detect_environment', {}, this.abortController.signal)
        .catch(() => '');
      this.environmentContext = '';
      if (envSnapshot) {
        try {
          const parsed = JSON.parse(envSnapshot);
          if (parsed.environment) {
            this.environmentContext = parsed.environment;
          }
        } catch {
          /* ignore parse error */
        }
      }

      this.state.messages = [
        { role: 'system', content: this.buildSystemPromptWithSummary() },
        { role: 'user', content: userMessage },
      ];
    } else {
      // 3. 后续请求：追加新用户消息到已有对话历史，并刷新 system prompt 以同步最新时间与记忆
      if (this.memoryProvider) {
        this.unifiedMemory = await this.memoryProvider
          .fetchUnifiedMemory()
          .catch(() => this.unifiedMemory);
      }
      this.state.messages[0] = {
        role: 'system',
        content: this.buildSystemPromptWithSummary(),
      };
      this.state.messages.push({
        role: 'user',
        content: userMessage,
      });
    }

    // 3. Run agent loop
    try {
      await this.runLoop();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if ((this.state.status as string) !== 'idle') {
        this.sendToFrontend({
          type: 'agent_frame',
          subType: 'error',
          message: `Agent 执行异常: ${errMsg}`,
        });
        this.state.status = 'idle';
      }
    }
  }

  agentAbort(): void {
    this.pendingDistillationSnapshot = null;
    if (this.state.status === 'running') {
      this.abortController.abort('user_stop');
      this.sendToFrontend({
        type: 'agent_frame',
        subType: 'response',
        content: 'Agent 已停止。',
      });
      this.state.status = 'idle';
    }
  }

  private async runLoop(): Promise<void> {
    const signal = this.abortController.signal;
    const runController = this.abortController;
    this.resetTimeout();

    // 防止 DO Hibernate：整个 runLoop 期间保持 DO 活跃
    // （覆盖命令执行等待、用户确认等待、LLM 流式响应等所有 await 场景）
    // 与 loopTimeout 不同，keepAlive 是 no-op，不会 abort 新 controller，
    // 无需在 handleAgentStart 中提前清理，用局部变量即可。
    const keepAlive = setInterval(() => {}, 5000);

    this.progress = {
      uniqueCommands: new Set(),
      recentToolCalls: [],
      extensionUsed: 0,
    };

    try {
      while (true) {
        if (signal.aborted) break;

        const effectiveMax = this.getEffectiveMaxIterations();
        if (this.state.iteration >= effectiveMax) {
          const eval_ = this.evaluateProgress();
          if (eval_.shouldExtend) {
            this.progress.extensionUsed++;
            this.sendToFrontend({
              type: 'agent_frame',
              subType: 'progress_extend',
              message: `任务仍在进行中，自动延长迭代上限（+${PROGRESS_CONFIG.extensionSize}）`,
              currentIteration: this.state.iteration,
              newMax: this.getEffectiveMaxIterations(),
              reason: eval_.reason,
            });
            continue;
          } else {
            this.sendToFrontend({
              type: 'agent_frame',
              subType: 'response',
              content: `Agent 达到迭代上限（${this.state.iteration} 次）。${eval_.reason}。请检查终端状态，或发送新消息继续操作。`,
            });
            break;
          }
        }

        // Notify frontend: thinking
        this.sendToFrontend({
          type: 'agent_frame',
          subType: 'thinking',
          iteration: this.state.iteration,
        });

        // Call LLM
        let llmResponse: ChatCompletionResponse;
        try {
          llmResponse = await this.callLLM(signal);
          this.resetTimeout(); // 看门狗：LLM 响应成功，重置超时时间
        } catch (e) {
          if (signal.aborted) break;
          const errMsg = e instanceof Error ? e.message : String(e);
          this.sendToFrontend({
            type: 'agent_frame',
            subType: 'error',
            message: `LLM 调用失败: ${errMsg}`,
          });
          break;
        }

        const choice = llmResponse.choices?.[0];
        if (!choice) {
          this.sendToFrontend({
            type: 'agent_frame',
            subType: 'error',
            message: 'LLM 未返回有效响应',
          });
          break;
        }

        // If LLM has tool_calls -> execute tools
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          // Add assistant message with tool_calls to history
          this.state.messages.push({
            role: 'assistant',
            content: choice.message.content,
            tool_calls: choice.message.tool_calls,
          });

          for (const toolCall of choice.message.tool_calls) {
            if (signal.aborted) break;

            // Notify frontend: executing
            let toolArgs: any = {};
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              toolArgs = { command: toolCall.function.arguments };
            }

            this.sendToFrontend({
              type: 'agent_frame',
              subType: 'executing',
              tool: toolCall.function.name,
              args: toolArgs,
            });

            // Execute tool call
            const result = await this.toolExecutor.execute(toolCall.function.name, toolArgs, signal);
            this.recordToolCall(toolCall.function.name, toolArgs);
            this.resetTimeout(); // 看门狗：工具执行成功，重置超时时间

            // 必须先将 tool 结果加入 messages，否则后续轮次的 LLM 调用会因
            // assistant.tool_calls 缺少对应的 tool 响应而触发 API 400 错误
            this.state.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
          }

          if (signal.aborted) break;
          this.state.iteration++;
          continue;
        }

        // No tool_calls -> 模型直接以文本形式回复，保存 assistant 响应到历史，并确保前端收到最终回复
        const finalContent = choice.message.content?.trim();
        if (finalContent) {
          if (!choice.message.streamed) {
            this.sendToFrontend({
              type: 'agent_frame',
              subType: 'response',
              content: finalContent,
            });
          }
        } else {
          // 极端异常兜底：模型返回空内容时给出明确提示，防止前端悬空或静默无输出
          this.sendToFrontend({
            type: 'agent_frame',
            subType: 'response',
            content: this.preferredLocale === 'en-US' ? 'Task completed.' : '任务已执行完成。',
          });
        }

        this.state.messages.push({
          role: 'assistant',
          content: choice.message.content || (this.preferredLocale === 'en-US' ? 'Task completed.' : '任务已执行完成。'),
        });
        this.state.status = 'idle';
        const snapshotMsgs = extractDistillationSnapshot(this.state.messages);
        void this.triggerMemoryDistillationIfEligible(snapshotMsgs);
        return;
      }

      // Loop exited — notify frontend of the reason
      if (signal.aborted) {
        // 超时退出（排除用户手动停止，agentAbort 已自行通知）
        if (!String(signal.reason || '').includes('user_stop')) {
          this.sendToFrontend({
            type: 'agent_frame',
            subType: 'response',
            content: `Agent 执行超时（已运行 ${this.state.iteration} 步），已自动停止。请检查终端状态，或发送新消息继续操作。`,
          });
        }
      }

      // 迭代上限或非用户主动停止的退出：若已有实质性命令执行，触发阶段性记忆提炼
      if (this.state.iteration > 0 && !String(signal.reason || '').includes('user_stop')) {
        const snapshotMsgs = extractDistillationSnapshot(this.state.messages);
        void this.triggerMemoryDistillationIfEligible(snapshotMsgs);
      }
    } catch (e) {
      // 仅处理非 abort 异常（abort 路径已在 while 退出后处理）
      if (!signal.aborted) throw e;
    } finally {
      // Clear our own timeout
      if (this.loopTimeout) {
        clearTimeout(this.loopTimeout);
        this.loopTimeout = null;
      }
      // 清理 keepAlive 定时器，防止 runLoop 结束后 DO 仍持有无效 timer
      clearInterval(keepAlive);
      // Only the current (not-superseded) loop may transition state to idle,
      // preventing a stale loop aborted by a newer request from clobbering the new run.
      if (this.abortController === runController && this.state.status !== 'idle') {
        this.state.status = 'idle';
      }
    }
  }

  private resetTimeout(): void {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
    }
    const currentController = this.abortController;
    this.loopTimeout = setTimeout(() => {
      if (this.state.status === 'running') {
        currentController.abort('loop_timeout');
      }
    }, this.config.timeout);
  }

  private pauseTimeout(): void {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
      this.loopTimeout = null;
    }
  }

  private async callLLM(signal: AbortSignal): Promise<ChatCompletionResponse> {
    const config = this.agentConfig!;
    const maxRetries = 2;
    const retryableStatuses = [429, 500, 502, 503, 504];

    // 每次 LLM 调用前刷新终端快照
    await this.refreshTerminalSnapshot();

    await this.trimMessages();

    // 校验消息完整性：确保每个 assistant.tool_calls 都有对应的 tool 响应
    // 剔除不配对的消息，避免 OpenAI API 400 错误
    const validMessages = this.validateMessages([
      { role: 'system' as const, content: this.buildSystemPromptWithSummary() },
      ...this.state.messages.slice(1),
    ]);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) throw new Error('Aborted');

      // base_url was fully validated (string + DNS) at config time before being
      // saved to DB. Agent reads it from DB — no need to re-validate here.
      // redirect: 'manual' below remains as the last-line defence.

      let cleanBaseUrl = config.base_url.replace(/\/$/, '');
      if (cleanBaseUrl.endsWith('/chat/completions')) {
        cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length);
      }

      const res = await fetch(`${cleanBaseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'manual', // Cloudflare Workers only supports 'follow' or 'manual'
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: validMessages,
          tools: AGENT_TOOLS,
          tool_choice: 'auto',
          max_tokens: 4096,
          stream: true,
        }),
        signal,
      });

      if (res.status >= 300 && res.status < 400) {
        throw new Error(
          `SSRF Protection: AI provider attempted an unauthorized redirect (HTTP ${res.status})`
        );
      }

      if (res.ok) {
        return this.handleStreamingResponse(res, signal);
      }

      if (!retryableStatuses.includes(res.status) || attempt === maxRetries) {
        const err = await res.text().catch(() => 'Unknown error');
        throw new Error(`LLM API error ${res.status}: ${err.slice(0, 500)}`);
      }

      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }

    throw new Error('LLM API: max retries exceeded');
  }

  private async handleStreamingResponse(
    res: Response,
    signal: AbortSignal
  ): Promise<ChatCompletionResponse> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let contentText = '';
    let reasoningText = '';
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let hasToolCalls = false;

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            const reasoning = delta.reasoning_content || delta.reasoning;
            if (reasoning) {
              reasoningText += reasoning;
            }

            if (delta.content) {
              contentText += delta.content;
              // 仅当目前未出现有效工具调用时，向前端流式传输文本
              if (!hasToolCalls) {
                this.sendToFrontend({
                  type: 'agent_frame',
                  subType: 'stream_chunk',
                  content: delta.content,
                });
              }
            }

            // 严格检查 tool_calls：必须是非空数组且包含有效函数调用
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls.has(idx)) {
                  toolCalls.set(idx, { id: tc.id || '', name: '', arguments: '' });
                }
                const existing = toolCalls.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                if (tc.function?.name || tc.id) {
                  hasToolCalls = true;
                }
              }
            }
          } catch {
            /* skip malformed SSE lines */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 构建有效工具调用列表
    const assembledToolCalls = Array.from(toolCalls.values())
      .filter((tc) => tc.name)
      .map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));

    const actualHasToolCalls = assembledToolCalls.length > 0;
    let streamed = false;

    // 若无工具调用，且 content 为空但有 reasoning_content（如部分推理模型），回退到 reasoning
    if (!actualHasToolCalls) {
      if (!contentText.trim() && reasoningText.trim()) {
        contentText = reasoningText;
      }
      if (contentText.trim()) {
        this.sendToFrontend({
          type: 'agent_frame',
          subType: 'stream_end',
          content: contentText,
        });
        streamed = true;
      }
    }

    return {
      id: '',
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: contentText || null,
            tool_calls: actualHasToolCalls ? assembledToolCalls : undefined,
            streamed,
          },
          finish_reason: actualHasToolCalls ? 'tool_calls' : 'stop',
        },
      ],
    };
  }

  /**
   * 刷新终端快照（更新 system prompt 中的终端上下文）
   */
  private async refreshTerminalSnapshot(): Promise<void> {
    const terminalSnapshot = this.terminalContext.snapshot(200);
    if (terminalSnapshot) {
      this.terminalContextSnapshot = terminalSnapshot;
    }
  }

  /**
   * 校验消息完整性：确保每条带 tool_calls 的 assistant 消息之后都有
   * 足够数量和匹配 ID 的 tool 响应。剔除不配对的消息，防止 LLM API 400 错误。
   */
  private validateMessages(msgs: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    let i = 0;

    while (i < msgs.length) {
      const msg = msgs[i];

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
        const matchedTools: ChatMessage[] = [];
        let j = i + 1;

        // 收集后续匹配的 tool 消息
        while (j < msgs.length && msgs[j].role === 'tool') {
          if (expectedIds.has(msgs[j].tool_call_id!)) {
            matchedTools.push(msgs[j]);
          }
          j++;
        }

        // 仅当所有 tool_calls 都有匹配响应时才保留
        if (matchedTools.length >= expectedIds.size) {
          result.push(msg);
          result.push(...matchedTools);
        }
        // 不完整或缺失 → 跳过整组，跳到 tool 消息之后继续
        i = j;
      } else if (msg.role === 'tool') {
        // 孤立 tool 消息（前面没有 assistant.tool_calls）→ 丢弃
        i++;
      } else {
        result.push(msg);
        i++;
      }
    }

    return result;
  }

  /**
   * 对历史较早轮次的 tool 输出进行轻量压缩，保持单轮与多轮长任务的上下文有界。
   * 保留最近 6 次工具交互的完整输出；更早的工具消息若超出 300 字符，保留头尾精简概要。
   * 严格保留 tool_call_id 与消息配对结构，杜绝 API 400。
   */
  private compactHistoricalToolOutputs(): void {
    const toolIndices: number[] = [];
    for (let i = 1; i < this.state.messages.length; i++) {
      if (this.state.messages[i].role === 'tool') {
        toolIndices.push(i);
      }
    }

    if (toolIndices.length <= 6) return;

    const toCompactIndices = toolIndices.slice(0, -6);
    for (const idx of toCompactIndices) {
      const msg = this.state.messages[idx];
      if (msg.content && msg.content.length > 300) {
        const head = msg.content.slice(0, 200);
        const tail = msg.content.slice(-80);
        msg.content = `${head}\n[...更早历史执行输出已压缩...]\n${tail}`;
      }
    }
  }

  private async trimMessages(): Promise<void> {
    const recentRoundsCount = 8; // 保留 8 轮上下文

    // 1. 无论是多轮还是单轮长任务，对较早累积的 tool 消息进行轻量概要压缩，防爆上下文
    this.compactHistoricalToolOutputs();

    if (this.state.messages.length <= 40) return; // 40 条以内不裁剪（工具结果已在序列化前单独截断）

    const conversationMsgs = this.state.messages.slice(1);

    type RoundSegment = { assistant: ChatMessage; tools: ChatMessage[] };
    type Round = { user: ChatMessage; segments: RoundSegment[] };

    const rounds: Round[] = [];
    let currentUser: ChatMessage | null = null;
    let currentSegments: RoundSegment[] = [];

    for (const msg of conversationMsgs) {
      if (msg.role === 'user') {
        if (currentUser && currentSegments.length > 0) {
          rounds.push({ user: currentUser, segments: [...currentSegments] });
        }
        currentUser = msg;
        currentSegments = [];
      } else if (msg.role === 'assistant') {
        currentSegments.push({ assistant: msg, tools: [] });
      } else if (msg.role === 'tool') {
        if (currentSegments.length > 0) {
          currentSegments[currentSegments.length - 1].tools.push(msg);
        }
      }
    }
    if (currentUser && currentSegments.length > 0) {
      rounds.push({ user: currentUser, segments: currentSegments });
    }

    if (rounds.length <= recentRoundsCount) return;

    const toSummarizeRounds = rounds.slice(0, -recentRoundsCount);
    const recentRounds = rounds.slice(-recentRoundsCount);

    const toSummarize = toSummarizeRounds.flatMap((r) => {
      const msgs: ChatMessage[] = [r.user];
      for (const seg of r.segments) {
        msgs.push(seg.assistant);
      }
      return msgs;
    });

    const summary = await this.generateSummaryWithLLM(toSummarize, this.state.summary);
    if (summary) {
      this.state.summary = summary;
    }

    const recentMsgs = recentRounds.flatMap((r) => {
      const msgs: ChatMessage[] = [r.user];
      for (const seg of r.segments) {
        msgs.push(seg.assistant);
        msgs.push(...seg.tools);
      }
      return msgs;
    });

    this.state.messages = [
      { role: 'system', content: this.buildSystemPromptWithSummary() },
      ...recentMsgs,
    ];

    await this.refreshEnvironmentContext();
  }

  /**
   * 刷新环境上下文（更新 system prompt 中的环境信息）
   */
  private async refreshEnvironmentContext(): Promise<void> {
    const envSnapshot = await this.toolExecutor
      .execute('detect_environment', {}, this.abortController.signal)
      .catch(() => '');
    if (!envSnapshot) return;

    try {
      const parsed = JSON.parse(envSnapshot);
      if (parsed.environment) {
        this.environmentContext = parsed.environment;
      }
    } catch {
      /* ignore parse error */
    }
  }

  private buildSystemPromptWithSummary(): string {
    const basePrompt = getSystemPrompt();
    const languageInstruction = getResponseLanguageInstruction(this.preferredLocale);
    const parts: string[] = [basePrompt, languageInstruction];

    if (this.environmentContext) {
      parts.push(`## 当前服务器环境\n${this.environmentContext}`);
    }
    if (this.terminalContextSnapshot) {
      parts.push(`## 交互式终端最近输出\n${this.terminalContextSnapshot}`);
    }
    if (this.state.summary) {
      parts.push(`## 当前会话未决任务与决策摘要\n${this.state.summary}`);
    }
    if (this.unifiedMemory.workLogs.length > 0 || this.unifiedMemory.knowledge.length > 0) {
      const memoryText = formatServerMemoryForPrompt(
        this.unifiedMemory,
        this.preferredLocale,
        Date.now(),
        this.userTimezone
      );
      if (memoryText) {
        parts.push(memoryText);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * 调用 LLM 生成对话摘要
   * 只处理 user 和 assistant 消息，丢弃历史 tool 消息
   */
  private async generateSummaryWithLLM(
    toSummarize: ChatMessage[],
    existingSummary?: string
  ): Promise<string | null> {
    // 消息变化量不足 4 条时跳过摘要生成
    if (toSummarize.length - this.lastSummaryMessageCount < 4 && existingSummary) {
      return existingSummary;
    }
    this.lastSummaryMessageCount = toSummarize.length;

    const config = this.agentConfig;
    if (!config) return null;

    // 将消息转换为可读格式（只处理 user 和 assistant）
    const conversationText = toSummarize
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        if (m.role === 'user') {
          return `用户: ${m.content}`;
        } else if (m.role === 'assistant') {
          if (m.tool_calls) {
            const cmds = m.tool_calls.map((tc) => tc.function.name).join(', ');
            return `AI: [调用工具: ${cmds}]`;
          }
          return `AI: ${m.content}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    // 如果内容太短，不需要摘要
    if (conversationText.length < 200 && !existingSummary) return null;

    const previousSection = existingSummary
      ? `\n\n已有摘要（请在其基础上合并新内容，不要丢失已有关键信息）：\n${existingSummary}`
      : '';

    const summaryPrompt = `请将以下运维对话压缩为会话待办与决策上下文摘要，特别关注：
- 当前正在进行或未完成的运维任务目标
- 用户明确的偏好选择或已做出的关键决策
- AI 提出的建议及需要用户后续确认的选项
- 任何阻碍当前任务的阻塞点或错误结论
注意：无需罗列琐碎的具体命令执行日志（系统已有独立工作历程记录），专注于保持人机对话的决策连续性与未决状态。
控制在 300 字以内，使用精炼的要点列表。如有已有摘要，请在其基础上合并新内容，不丢失关键决策。

对话内容：
${conversationText}${previousSection}`;

    try {
      // base_url was fully validated at config time — no runtime re-check needed.

      let cleanBaseUrl = config.base_url.replace(/\/$/, '');
      if (cleanBaseUrl.endsWith('/chat/completions')) {
        cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length);
      }

      const res = await fetch(`${cleanBaseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'manual', // Cloudflare Workers only supports 'follow' or 'manual'
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: summaryPrompt }],
          max_tokens: 512,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(10000), // Summary 10秒超时
      });

      if (res.status >= 300 && res.status < 400) {
        console.error('SSRF Summary Fetch Redirect blocked:', res.status);
        return null;
      }

      if (res.ok) {
        const data = await res.json<{ choices: Array<{ message: { content: string } }> }>();
        return data.choices?.[0]?.message?.content || null;
      }
    } catch {
      // LLM 调用失败，返回 null（不生成摘要）
    }

    return null;
  }

  private async triggerMemoryDistillationIfEligible(snapshotMsgs: ChatMessage[]): Promise<void> {
    if (!this.memoryProvider || snapshotMsgs.length < 2 || shouldBypassDistillation(snapshotMsgs)) {
      return;
    }
    if (this.distillationInProgress) {
      // 正在提炼中：记录最新排队快照，避免多轮连续交互直接丢弃最新结果
      this.pendingDistillationSnapshot = snapshotMsgs;
      return;
    }
    this.distillationInProgress = true;
    try {
      await this.distillMemoryWithLLM(snapshotMsgs);
    } catch {
      // 提炼失败不得影响正常交互
    } finally {
      this.distillationInProgress = false;
      if (this.pendingDistillationSnapshot) {
        const nextSnapshot = this.pendingDistillationSnapshot;
        this.pendingDistillationSnapshot = null;
        void this.triggerMemoryDistillationIfEligible(nextSnapshot);
      }
    }
  }

  private async distillMemoryWithLLM(snapshotMsgs: ChatMessage[]): Promise<void> {
    try {
      const config = this.agentConfig;
      if (!config || !this.memoryProvider) return;

      const latestLog = this.unifiedMemory.workLogs?.[0];
      const isRecentConsecutive = Boolean(
        latestLog &&
          typeof latestLog.updated_at === 'number' &&
          Date.now() - latestLog.updated_at < CONSECUTIVE_TASK_WINDOW_MS
      );

      // 选取刚才同步快照的消息，并融合已有的近期 WorkLog 与 Knowledge 键值清单
      const promptInput = formatDistillationPromptInput(
        snapshotMsgs,
        this.unifiedMemory.workLogs,
        this.unifiedMemory.knowledge,
        {
          now: Date.now(),
          locale: this.preferredLocale,
          timeZone: this.userTimezone,
        }
      );
      if (!promptInput || promptInput.trim().length === 0) return;

      let cleanBaseUrl = config.base_url.replace(/\/$/, '');
      if (cleanBaseUrl.endsWith('/chat/completions')) {
        cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length);
      }

      const res = await fetch(`${cleanBaseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: MEMORY_DISTILLATION_PROMPT },
            { role: 'user', content: promptInput },
          ],
          max_tokens: 1500,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (res.status >= 300 && res.status < 400) {
        console.error('SSRF Distillation Fetch Redirect blocked:', res.status);
        return;
      }

      if (!res.ok) {
        console.warn(`Memory distillation HTTP error: ${res.status}`);
        return;
      }

      const data = await res.json<{ choices: Array<{ message: { content: string } }> }>();
      const rawContent = data.choices?.[0]?.message?.content?.trim();
      if (!rawContent) return;

      const parsed = extractDistillationJson(rawContent);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('Memory distillation JSON extraction returned non-object or null');
        return;
      }

      let workLogToSave: { mode?: WorkLogMode; title: string; summary: string } | undefined;
      if (parsed.workLog && typeof parsed.workLog === 'object') {
        let desiredMode = parsed.workLog.mode;
        // 容错兜底：若在近期连续会话中且模型未显式输出 mode，默认按 update_latest 合并更新
        if (!desiredMode && isRecentConsecutive) {
          desiredMode = 'update_latest';
        }

        const normLog = normalizeWorkLogInput(
          {
            mode: desiredMode,
            title: parsed.workLog.title,
            summary: parsed.workLog.summary,
          },
          { truncate: true }
        );
        if (normLog.ok) {
          workLogToSave = normLog.value;
        }
      }

      const knowledgeToSave: Array<{
        action?: KnowledgeAction;
        category: any;
        key: string;
        value: string;
      }> = [];
      if (Array.isArray(parsed.knowledge)) {
        for (const k of parsed.knowledge) {
          const normK = normalizeKnowledgeInput(
            {
              action: k.action,
              category: k.category,
              key: k.key,
              value: k.value,
            },
            { truncate: true }
          );
          if (normK.ok) {
            knowledgeToSave.push(normK.value);
          }
        }
      }

      if (workLogToSave || knowledgeToSave.length > 0) {
        await this.memoryProvider.saveBatchMemory({
          workLog: workLogToSave,
          knowledge: knowledgeToSave.length > 0 ? knowledgeToSave : undefined,
        });
        this.unifiedMemory = await this.memoryProvider
          .fetchUnifiedMemory()
          .catch(() => this.unifiedMemory);
        this.sendToFrontend({
          type: 'agent_frame',
          subType: 'memory_updated',
        });
      }
    } catch (e) {
      console.warn('Memory distillation failed:', e instanceof Error ? e.message : String(e));
    }
  }
}
