// Native, stateless Responses items and the small server-memory contract.
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
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

export interface ResponseMessage {
  type: 'message';
  id?: string;
  phase?: 'commentary' | 'final_answer' | null;
  role: 'assistant';
  status: 'completed' | 'incomplete' | 'in_progress';
  content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }
    | { type: 'refusal'; refusal: string }>;
}

export interface ResponseReasoning {
  type: 'reasoning';
  id?: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content?: string | null;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  status?: 'completed' | 'incomplete' | 'in_progress';
}

export type ResponseOutput = ResponseMessage | ResponseFunctionCall | ResponseReasoning;
export type ResponseInput =
  | { role: 'user'; content: string }
  | { type: 'message'; role: 'user'; content: Array<{ type: 'input_text'; text: string }>; id?: string; status?: 'completed' }
  | ResponseOutput
  | { type: 'function_call_output'; call_id: string; output: string };

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
  strict: boolean;
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
  /** Locally generated correlation ID, never an upstream ID or header. */
  requestId?: string;
  id: string;
  text: string;
  calls: ResponseFunctionCall[];
  output: ResponseOutput[];
  usage?: ResponseUsage;
  status?: 'completed' | 'incomplete';
  incompleteReason?: string;
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
  context_window?: number | null;
  max_output_tokens?: number | null;
}

export type AgentStatus = 'idle' | 'running';
export type RunOutcome = 'completed' | 'stopped' | 'failed' | 'limit';

export interface AgentFrame {
  type: 'agent_frame';
  subType: 'run_start' | 'run_end' | 'thinking' | 'executing' | 'response' | 'error'
    | 'confirm_required' | 'stream_chunk' | 'stream_end'
    | 'memory_updated' | 'memory_status' | 'context_status' | 'reset_done';
  [key: string]: unknown;
}

export interface MemoryTask {
  taskId: string;
  goal: string;
  conversation: string;
  locale: 'zh-CN' | 'zh-TW' | 'en-US';
  timezone: string;
}

export interface AgentMemoryBatch {
  expectedRevision?: number;
  workLog?: { mode?: WorkLogMode; title: string; summary: string } | null;
  knowledge?: Array<{ action?: KnowledgeAction; category?: KnowledgeCategory; key: string; value?: string }>;
}

export interface AgentMemoryProvider {
  fetchUnifiedMemory(signal?: AbortSignal): Promise<UnifiedServerMemory>;
  enqueueMemory(task: MemoryTask): Promise<void>;
}
