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
  maxIterations: 20,
  timeout: 120_000,
};

export class AgentCore {
  private state: AgentState = { status: 'idle', messages: [], iteration: 0 };
  private abortController: AbortController = new AbortController();
  private agentConfig: AIConfig | null = null;
  private config: AgentConfig;
  private toolExecutor: ToolExecutor;
  private loopTimeout: ReturnType<typeof setTimeout> | null = null;

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
      this.askConfirmation.bind(this),
    );
  }

  getStatus(): string {
    return this.state.status;
  }

  async handleAgentStart(userId: string, userMessage: string): Promise<void> {
    // Guard: abort previous run if still active
    if (this.state.status === 'running' || this.state.status === 'waiting_confirmation') {
      this.abortController.abort('new_request');
    }
    // Cancel the previous loop's stale timeout so it can't abort the new controller
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
      this.loopTimeout = null;
    }

    this.state = { status: 'running', messages: [], iteration: 0, summary: undefined };
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

    // 2. Read terminal context + detect environment as initial observation
    const terminalSnapshot = this.terminalContext.snapshot(200);
    const envSnapshot = await this.toolExecutor.execute('detect_environment', {}, this.abortController.signal).catch(() => '');

    let userContent = '';
    if (envSnapshot) {
      try {
        const parsed = JSON.parse(envSnapshot);
        if (parsed.environment) {
          userContent += `[ENVIRONMENT]\n${parsed.environment}\n[/ENVIRONMENT]\n\n`;
        }
      } catch { /* ignore parse error */ }
    }
    if (terminalSnapshot) {
      userContent += `[TERMINAL]\n${terminalSnapshot}\n[/TERMINAL]\n\n`;
    }
    userContent += `用户请求: ${userMessage}`;

    this.state.messages = [
      { role: 'system', content: getSystemPrompt() },
      { role: 'user', content: userContent },
    ];

    // 3. Run agent loop
    try {
      await this.runLoop();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (this.state.status !== 'idle') {
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
    if (this.state.status === 'running' || this.state.status === 'waiting_confirmation') {
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
    const loopTimeout = setTimeout(() => {
      if (this.state.status === 'running') {
        runController.abort('loop_timeout');
      }
    }, this.config.timeout);
    this.loopTimeout = loopTimeout;

    try {
      while (this.state.iteration < this.config.maxIterations) {
        if (signal.aborted) break;

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

            // Add tool result to messages
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

        // No tool_calls -> direct text response, end loop
        this.sendToFrontend({
          type: 'agent_frame',
          subType: 'response',
          content: choice.message.content || '',
        });
        this.state.status = 'idle';
        return;
      }

      // Max iterations reached
      if (!signal.aborted && this.state.status === 'running') {
        this.sendToFrontend({
          type: 'agent_frame',
          subType: 'response',
          content: 'Agent 达到最大迭代次数，请检查终端状态或尝试更简洁的请求。',
        });
        this.state.status = 'idle';
      }
    } catch (e) {
      if (signal.aborted) {
        if (!signal.reason?.includes?.('user_stop')) {
          this.sendToFrontend({
            type: 'agent_frame',
            subType: 'response',
            content: 'Agent 执行超时。',
          });
        }
      } else {
        throw e;
      }
    } finally {
      // Clear our own timeout; null the instance field if it still points to ours
      clearTimeout(loopTimeout);
      if (this.loopTimeout === loopTimeout) {
        this.loopTimeout = null;
      }
      // Only the current (not-superseded) loop may transition state to idle,
      // preventing a stale loop aborted by a newer request from clobbering the new run.
      if (this.abortController === runController && this.state.status !== 'idle') {
        this.state.status = 'idle';
      }
    }
  }

  private async callLLM(signal: AbortSignal): Promise<ChatCompletionResponse> {
    const config = this.agentConfig!;
    const maxRetries = 2;
    const retryableStatuses = [429, 500, 502, 503, 504];

    await this.trimMessages();

    // 构建发送给 LLM 的消息（使用包含摘要的 system prompt）
    const messagesToSend = [
      { role: 'system' as const, content: this.buildSystemPromptWithSummary() },
      ...this.state.messages.slice(1), // 跳过原始 system 消息
    ];

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
          messages: messagesToSend,
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

  private async trimMessages(): Promise<void> {
    // 摘要式上下文管理：
    // 当消息超过限制时，调用 LLM 将早期消息压缩为摘要
    // 保留最近 N 轮对话（user + assistant），丢弃历史 tool 消息
    const recentRoundsCount = 3; // 保留最近 3 轮对话
    if (this.state.messages.length <= 10) return; // 消息太少不需要裁剪

    // 1. 分离系统消息和对话消息
    const systemMsg = this.state.messages[0]; // system
    const firstUserMsg = this.state.messages[1]; // first user (env context)
    const conversationMsgs = this.state.messages.slice(2); // 对话消息

    // 2. 提取轮次：一轮 = user + assistant（可能有 tool_calls）
    // 历史 tool 消息不计入轮次，仅在当前轮次需要
    const rounds: Array<{ user: ChatMessage; assistant: ChatMessage; tools: ChatMessage[] }> = [];
    let currentUser: ChatMessage | null = null;
    let currentAssistant: ChatMessage | null = null;
    const currentTools: ChatMessage[] = [];

    for (const msg of conversationMsgs) {
      if (msg.role === 'user') {
        // 新的轮次开始，保存上一轮
        if (currentUser && currentAssistant) {
          rounds.push({ user: currentUser, assistant: currentAssistant, tools: [] });
        }
        currentUser = msg;
        currentAssistant = null;
        currentTools.length = 0;
      } else if (msg.role === 'assistant') {
        currentAssistant = msg;
      } else if (msg.role === 'tool') {
        currentTools.push(msg);
      }
    }
    // 保存最后一轮
    if (currentUser && currentAssistant) {
      rounds.push({ user: currentUser, assistant: currentAssistant, tools: currentTools });
    }

    // 3. 分离需要摘要的轮次和保留的轮次
    if (rounds.length <= recentRoundsCount) return; // 不需要裁剪

    const toSummarizeRounds = rounds.slice(0, -recentRoundsCount);
    const recentRounds = rounds.slice(-recentRoundsCount);

    // 4. 调用 LLM 生成摘要（只摘要 user + assistant，丢弃 tool 消息）
    const toSummarize = toSummarizeRounds.flatMap(r => [r.user, r.assistant]);
    const summary = await this.generateSummaryWithLLM(toSummarize);
    if (summary) {
      this.state.summary = summary;
    }

    // 5. 构建新消息：[system + 摘要] + [first user] + 最近 N 轮（user + assistant + 当前 tools）
    const recentMsgs = recentRounds.flatMap(r => {
      const msgs: ChatMessage[] = [r.user, r.assistant];
      // 只保留最后一轮的 tool 消息（当前轮次需要）
      if (r === recentRounds[recentRounds.length - 1] && r.tools.length > 0) {
        msgs.push(...r.tools);
      }
      return msgs;
    });

    this.state.messages = [
      { role: 'system', content: this.buildSystemPromptWithSummary() },
      firstUserMsg,
      ...recentMsgs,
    ];
  }

  private buildSystemPromptWithSummary(): string {
    const basePrompt = getSystemPrompt();
    if (this.state.summary) {
      return `${basePrompt}\n\n## 之前的对话摘要\n${this.state.summary}`;
    }
    return basePrompt;
  }

  /**
   * 调用 LLM 生成对话摘要
   * 只处理 user 和 assistant 消息，丢弃历史 tool 消息
   */
  private async generateSummaryWithLLM(toSummarize: ChatMessage[]): Promise<string | null> {
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
    if (conversationText.length < 200) return null;

    const summaryPrompt = `请将以下运维对话压缩为简洁摘要，保留关键信息：
- 用户的主要请求和目标
- 已执行的关键操作和命令
- 当前状态和未完成的任务
- AI 提出的建议或需要用户确认的选项

要求：摘要控制在 500 字以内，使用要点列表格式。

对话内容：
${conversationText}`;

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
