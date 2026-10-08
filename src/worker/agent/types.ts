// Native, stateless Responses items. Evidence records are NOT protocol replay history.
import type { AgentTaskCheckpoint } from '../../agent-task-schema';
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

export interface ResponseMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  status: 'completed';
  content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }
    | { type: 'refusal'; refusal: string }>;
}

export interface ResponseReasoning {
  type: 'reasoning';
  id: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
}

export type ResponseOutput = ResponseMessage | ResponseFunctionCall | ResponseReasoning;
export type ResponseInput =
  | { role: 'user'; content: string }
  | ResponseOutput
  | { type: 'function_call_output'; call_id: string; output: string };

export type ExecutionStatus = 'succeeded' | 'failed' | 'blocked' | 'rejected'
  | 'cancelled' | 'invalid_arguments' | 'unknown';

export interface TaskRecord {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  calls?: ResponseFunctionCall[];
  callId?: string;
  status?: ExecutionStatus;
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
  output: ResponseOutput[];
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
    | 'memory_updated' | 'memory_status' | 'context_status' | 'reset_done';
  [key: string]: unknown;
}

export interface MemoryWriteContext { sessionId: string; epoch: number }
export interface AgentMemoryBatch extends MemoryWriteContext {
  expectedRevision: number;
  targetLogId?: number;
  workLog?: { mode?: WorkLogMode; title: string; summary: string };
  knowledge?: Array<{ action?: KnowledgeAction; category?: KnowledgeCategory; key: string; value?: string }>;
}
export interface AgentMemoryProvider {
  fetchUnifiedMemory(): Promise<UnifiedServerMemory>;
  saveBatchMemory(batch: AgentMemoryBatch): Promise<void>;
  beginSession?(context: MemoryWriteContext): Promise<void>;
  saveTaskCheckpoint?(checkpoint: AgentTaskCheckpoint, context: MemoryWriteContext): Promise<void>;
  fetchTaskCheckpoint?(taskId: string): Promise<AgentTaskCheckpoint>;
  deleteTaskCheckpoint?(taskId: string, context: MemoryWriteContext): Promise<void>;
}
