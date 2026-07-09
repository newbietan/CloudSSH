// Agent Core — control loop that runs inside Durable Object

import type {
  AgentConfig,
  AgentState,
  AIConfig,
  ChatCompletionResponse,
  ChatMessage,
} from './types';
import { AGENT_TOOLS } from './tools';
import { getSystemPrompt } from './prompt';
import { ToolExecutor } from './tool-executor';
import { TerminalContext } from './terminal-context';

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 30, // Changed from 20 to 30 as base
  timeout: 60_000, // 单步最大超时时间提升至 60 秒，匹配看门狗模式
};

interface ProgressTracker {
  uniqueCommands: Set<string>;
  recentToolCalls: string[];
  extensionUsed: number;
}

const PROGRESS_CONFIG = {
  baseIterations: 30,
  maxExtensions: 3,
  extensionSize: 20,
  maxTotalIterations: 90,
  loopDetectionWindow: 5,
  repetitionThreshold: 0.6,
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

  constructor(
    private terminalContext: TerminalContext,
    private sendToFrontend: (msg: any) => void,
    private fetchAIConfig: (userId: string) => Promise<AIConfig | null>,
    private execCommand: (command: string, timeout: number, signal?: AbortSignal) => Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>,
    private askConfirmation: (command: string, reason: string) => Promise<boolean>,
    config?: Partial<AgentConfig>,
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
    );
  }

  private getEffectiveMaxIterations(): number {
    return PROGRESS_CONFIG.baseIterations + this.progress.extensionUsed * PROGRESS_CONFIG.extensionSize;
  }

  private recordToolCall(toolName: string, args: any): void {
    const signature = toolName === 'execute_command'
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
    const { maxExtensions, maxTotalIterations, loopDetectionWindow, repetitionThreshold } = PROGRESS_CONFIG;

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
    if (uniqueCommandRatio < 0.3 && this.state.iteration > 10) {
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

  async handleAgentStart(userId: string, userMessage: string): Promise<void> {
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
      // 2. 首次启动：采集环境 + 终端上下文（注入 system prompt），用户消息保持干净
      this.terminalContextSnapshot = this.terminalContext.snapshot(200);
      const envSnapshot = await this.toolExecutor.execute('detect_environment', {}, this.abortController.signal).catch(() => '');
      this.environmentContext = '';
      if (envSnapshot) {
        try {
          const parsed = JSON.parse(envSnapshot);
          if (parsed.environment) {
            this.environmentContext = parsed.environment;
          }
        } catch { /* ignore parse error */ }
      }

      this.state.messages = [
        { role: 'system', content: this.buildSystemPromptWithSummary() },
        { role: 'user', content: userMessage },
      ];
    } else {
      // 3. 后续请求：追加新用户消息到已有对话历史
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
              content: `Agent 达到迭代上限（${this.state.iteration} 次）。${eval_.reason}。请检查终端状态或发送新消息继续。`,
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
            const result = await this.toolExecutor.execute(
              toolCall.function.name,
              toolArgs,
              signal,
            );
            this.recordToolCall(toolCall.function.name, toolArgs);
            this.resetTimeout(); // 看门狗：工具执行成功，重置超时时间

            // 必须先将 tool 结果加入 messages，否则后续轮次的 LLM 调用会因
            // assistant.tool_calls 缺少对应的 tool 响应而触发 API 400 错误
            this.state.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });

            // If respond_to_user -> end loop
            if (result.startsWith('RESPOND:')) {
              this.sendToFrontend({
                type: 'agent_frame',
                subType: 'response',
                content: result.slice(8),
              });
              this.state.status = 'idle';
              return;
            }
          }

          if (signal.aborted) break;
          this.state.iteration++;
          continue;
        }

        // No tool_calls -> 保存 assistant 响应到历史，然后结束
        this.state.messages.push({
          role: 'assistant',
          content: choice.message.content,
        });
        this.state.status = 'idle';
        return;
      }

      // Loop exited — notify frontend of the reason
      if (signal.aborted) {
        // 超时退出（排除用户手动停止，agentAbort 已自行通知）
        if (!signal.reason?.includes?.('user_stop')) {
          this.sendToFrontend({
            type: 'agent_frame',
            subType: 'response',
            content: 'Agent 执行超时，已自动停止。请检查终端状态，或发送新消息继续操作。',
          });
        }
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

      const res = await fetch(`${config.base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`,
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

      if (res.ok) {
        return this.handleStreamingResponse(res, signal);
      }

      if (!retryableStatuses.includes(res.status) || attempt === maxRetries) {
        const err = await res.text().catch(() => 'Unknown error');
        throw new Error(`LLM API error ${res.status}: ${err.slice(0, 500)}`);
      }

      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }

    throw new Error('LLM API: max retries exceeded');
  }

  private async handleStreamingResponse(
    res: Response,
    signal: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let contentText = '';
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

            if (delta.content) {
              contentText += delta.content;
              // Only stream text to frontend if no tool calls so far
              if (!hasToolCalls) {
                this.sendToFrontend({
                  type: 'agent_frame',
                  subType: 'stream_chunk',
                  content: delta.content,
                });
              }
            }

            if (delta.tool_calls) {
              hasToolCalls = true;
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls.has(idx)) {
                  toolCalls.set(idx, { id: tc.id || '', name: '', arguments: '' });
                }
                const existing = toolCalls.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If no tool calls, finalize streaming
    if (!hasToolCalls) {
      this.sendToFrontend({
        type: 'agent_frame',
        subType: 'stream_end',
        content: contentText,
      });
    }

    // Build response object for caller
    const assembledToolCalls = Array.from(toolCalls.values())
      .filter(tc => tc.name)
      .map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));

    return {
      id: '',
      choices: [{
        message: {
          role: 'assistant' as const,
          content: contentText || null,
          tool_calls: assembledToolCalls.length > 0 ? assembledToolCalls : undefined,
        },
        finish_reason: assembledToolCalls.length > 0 ? 'tool_calls' : 'stop',
      }],
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
        const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
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

  private async trimMessages(): Promise<void> {
    const recentRoundsCount = 6;
    if (this.state.messages.length <= 40) return;

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

    const toSummarize = toSummarizeRounds.flatMap(r => {
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

    const recentMsgs = recentRounds.flatMap(r => {
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
    const envSnapshot = await this.toolExecutor.execute('detect_environment', {}, this.abortController.signal).catch(() => '');
    if (!envSnapshot) return;

    try {
      const parsed = JSON.parse(envSnapshot);
      if (parsed.environment) {
        this.environmentContext = parsed.environment;
      }
    } catch { /* ignore parse error */ }
  }

  private buildSystemPromptWithSummary(): string {
    const basePrompt = getSystemPrompt();
    const parts: string[] = [basePrompt];

    if (this.environmentContext) {
      parts.push(`## 当前服务器环境\n${this.environmentContext}`);
    }
    if (this.terminalContextSnapshot) {
      parts.push(`## 交互式终端最近输出\n${this.terminalContextSnapshot}`);
    }
    if (this.state.summary) {
      parts.push(`## 之前的对话摘要\n${this.state.summary}`);
    }

    return parts.join('\n\n');
  }

  /**
   * 调用 LLM 生成对话摘要
   * 只处理 user 和 assistant 消息，丢弃历史 tool 消息
   */
  private async generateSummaryWithLLM(toSummarize: ChatMessage[], existingSummary?: string): Promise<string | null> {
    // 消息变化量不足 4 条时跳过摘要生成
    if (toSummarize.length - this.lastSummaryMessageCount < 4 && existingSummary) {
      return existingSummary;
    }
    this.lastSummaryMessageCount = toSummarize.length;

    const config = this.agentConfig;
    if (!config) return null;

    // 将消息转换为可读格式（只处理 user 和 assistant）
    const conversationText = toSummarize
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        if (m.role === 'user') {
          return `用户: ${m.content}`;
        } else if (m.role === 'assistant') {
          if (m.tool_calls) {
            const cmds = m.tool_calls.map(tc => tc.function.name).join(', ');
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

    const summaryPrompt = `请将以下运维对话压缩为简洁摘要，保留关键信息：
- 用户的主要请求和目标
- 已执行的关键操作和命令
- 当前状态和未完成的任务
- AI 提出的建议或需要用户确认的选项

要求：摘要控制在 500 字以内，使用要点列表格式。如有已有摘要，请在其基础上合并新内容，确保不丢失旧摘要中的关键信息。

对话内容：
${conversationText}${previousSection}`;

    try {
      const res = await fetch(`${config.base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: summaryPrompt }],
          max_tokens: 512,
          temperature: 0.3,
        }),
      });

      if (res.ok) {
        const data = await res.json<{ choices: Array<{ message: { content: string } }> }>();
        return data.choices?.[0]?.message?.content || null;
      }
    } catch {
      // LLM 调用失败，返回 null（不生成摘要）
    }

    return null;
  }
}
