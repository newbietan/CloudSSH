// Agent Core — control loop that runs inside Durable Object

import type {
  AgentConfig,
  AgentState,
  AIConfig,
  ChatCompletionResponse,
  ChatMessage,
  ToolCall,
} from './types';
import { AGENT_TOOLS_PHASE1 } from './tools';
import { getSystemPrompt } from './prompt';
import { ToolExecutor } from './tool-executor';
import { TerminalContext } from './terminal-context';

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 20,
  maxContextTokens: 8000,
  timeout: 120_000,
};

export class AgentCore {
  private state: AgentState = { status: 'idle', messages: [], iteration: 0 };
  private abortController: AbortController = new AbortController();
  private agentConfig: AIConfig | null = null;
  private config: AgentConfig;
  private toolExecutor: ToolExecutor;

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
    this.state = { status: 'running', messages: [], iteration: 0 };
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

    // 2. Read terminal context as initial observation
    const terminalSnapshot = this.terminalContext.snapshot(200);
    this.state.messages = [
      { role: 'system', content: getSystemPrompt(1) },
      {
        role: 'user',
        content: terminalSnapshot
          ? `[TERMINAL]\n${terminalSnapshot}\n[/TERMINAL]\n\n用户请求: ${userMessage}`
          : `用户请求: ${userMessage}`,
      },
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
    const loopTimeout = setTimeout(() => {
      if (this.state.status === 'running') {
        this.abortController.abort('loop_timeout');
      }
    }, this.config.timeout);

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

          let shouldReturn = false;

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
      clearTimeout(loopTimeout);
      if (this.state.status !== 'idle') {
        this.state.status = 'idle';
      }
    }
  }

  private async callLLM(signal: AbortSignal): Promise<ChatCompletionResponse> {
    const config = this.agentConfig!;

    // Trim messages if context gets too large
    this.trimMessages();

    const res = await fetch(`${config.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: this.state.messages,
        tools: AGENT_TOOLS_PHASE1,
        tool_choice: 'auto',
        max_tokens: 4096,
      }),
      signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      throw new Error(`LLM API error ${res.status}: ${err.slice(0, 500)}`);
    }

    return res.json() as Promise<ChatCompletionResponse>;
  }

  private trimMessages(): void {
    // Keep system message + last N messages, drop older ones to prevent context overflow
    const maxMessages = 40;
    if (this.state.messages.length > maxMessages) {
      const system = this.state.messages[0];
      const kept = this.state.messages.slice(-(maxMessages - 1));
      this.state.messages = [system, ...kept];
    }
  }
}
