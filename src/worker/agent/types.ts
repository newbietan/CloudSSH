// Agent type definitions shared across all agent modules

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description: string;
        enum?: string[];
      }>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgentConfig {
  maxIterations: number;
  timeout: number;
}

export type AgentStatus = 'idle' | 'running';

export interface AgentState {
  status: AgentStatus;
  messages: ChatMessage[];
  iteration: number;
  summary?: string; // 对话历史摘要（当消息被裁剪时生成）
}

export interface AgentFrame {
  type: 'agent_frame';
  subType: 'thinking' | 'executing' | 'response' | 'error' | 'confirm_required';
  [key: string]: unknown;
}

export interface AIConfig {
  base_url: string;
  model: string;
  api_key: string;
}
