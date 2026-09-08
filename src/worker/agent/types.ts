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
      properties: Record<
        string,
        {
          type: string;
          description: string;
          enum?: string[];
        }
      >;
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
      streamed?: boolean;
    };
    finish_reason: string;
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

import type {
  KnowledgeAction,
  KnowledgeCategory,
  ServerKnowledgeItem,
  ServerWorkLog,
  UnifiedServerMemory,
  WorkLogMode,
} from '../../server-memory-schema';

export type {
  ServerWorkLog,
  ServerKnowledgeItem,
  UnifiedServerMemory,
  KnowledgeCategory,
  WorkLogMode,
  KnowledgeAction,
};

export interface AgentMemoryProvider {
  fetchUnifiedMemory(): Promise<UnifiedServerMemory>;
  saveBatchMemory(batch: {
    workLog?: { mode?: WorkLogMode; title: string; summary: string };
    knowledge?: Array<{ action?: KnowledgeAction; category?: KnowledgeCategory; key: string; value?: string }>;
  }): Promise<void>;
}
