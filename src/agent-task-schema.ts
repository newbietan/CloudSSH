// Short-lived, application-owned recovery evidence. Never contains provider reasoning/items.
export const TASK_CHECKPOINT_TTL_MS = 30 * 60 * 1000;
export const TASK_CHECKPOINT_MAX_BYTES = 128 * 1024;
export const TASK_CHECKPOINT_MAX_COUNT = 4;
export const TASK_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface TaskOperation {
  callId: string;
  tool: string;
  description: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'rejected' | 'cancelled' | 'invalid_arguments' | 'unknown';
  executed: boolean;
  exitCode?: number;
  at: number;
}
export interface AgentTaskCheckpoint {
  taskId: string;
  goal: string;
  summary: string;
  operations: TaskOperation[];
  step: number;
  updatedAt: number;
}

export function validTaskCheckpoint(value: unknown): value is AgentTaskCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as AgentTaskCheckpoint;
  if (typeof v.taskId !== 'string' || !TASK_ID_PATTERN.test(v.taskId) ||
    typeof v.goal !== 'string' || !v.goal.trim() || v.goal.length > 16_000 ||
    typeof v.summary !== 'string' || v.summary.length > 8000 ||
    !Number.isSafeInteger(v.step) || v.step < 0 || !Number.isSafeInteger(v.updatedAt) ||
    !Array.isArray(v.operations) || v.operations.length > 256) return false;
  if (new TextEncoder().encode(JSON.stringify(value)).length > TASK_CHECKPOINT_MAX_BYTES) return false;
  const statuses = ['succeeded', 'failed', 'blocked', 'rejected', 'cancelled', 'invalid_arguments', 'unknown'];
  return v.operations.every(op => op && typeof op === 'object' &&
    typeof op.callId === 'string' && op.callId.length <= 80 &&
    typeof op.tool === 'string' && op.tool.length <= 64 &&
    typeof op.description === 'string' && op.description.length <= 256 &&
    statuses.includes(op.status) && typeof op.executed === 'boolean' &&
    (op.exitCode == null || Number.isSafeInteger(op.exitCode)) && Number.isSafeInteger(op.at));
}
