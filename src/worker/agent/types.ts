// Responses wire types and bounded, local task records. Task records are never replayed as chat history.
import type {
  KnowledgeAction,
  KnowledgeCategory,
  ServerKnowledgeItem,
  ServerWorkLog,
  UnifiedServerMemory,
  WorkLogMode,
} from '../../server-memory-schema';

export type { ServerWorkLog, ServerKnowledgeItem, UnifiedServerMemory, KnowledgeCategory, WorkLogMode, KnowledgeAction };

export interface ResponseFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

export type ResponseInput =
  | { role: 'user'; content: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface TaskRecord {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  calls?: ResponseFunctionCall[];
  callId?: string;
}

export interface ToolParameter {
  type: 'string' | 'number' | ['string' | 'number', 'null'];
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  strict: true;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface ModelResponse {
  id: string;
  text: string;
  calls: ResponseFunctionCall[];
  usage?: ResponseUsage;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgentConfig {
  maxIterations: number;
  timeout: number;
  inputTokenBudget: number;
  maxOutputTokens: number;
}

export interface AIConfig {
  base_url: string;
  model: string;
  api_key: string;
}

export type AgentStatus = 'idle' | 'running';
export type RunOutcome = 'completed' | 'stopped' | 'failed' | 'limit';

export interface AgentFrame {
  type: 'agent_frame';
  subType: 'run_start' | 'run_end' | 'thinking' | 'executing' | 'response' | 'error'
    | 'confirm_required' | 'stream_chunk' | 'stream_end' | 'progress_extend'
    | 'memory_updated' | 'reset_done';
  [key: string]: unknown;
}

export interface AgentMemoryProvider {
  fetchUnifiedMemory(): Promise<UnifiedServerMemory>;
  saveBatchMemory(batch: {
    workLog?: { mode?: WorkLogMode; title: string; summary: string };
    knowledge?: Array<{ action?: KnowledgeAction; category?: KnowledgeCategory; key: string; value?: string }>;
  }): Promise<void>;
}
