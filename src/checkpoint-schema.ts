/**
 * 服务器时序任务断点与连续性记忆（Server Task Checkpoint）共享校验模式。
 *
 * 供 Worker（/api/servers/:id/checkpoints → UserDBDO）与 Agent 提取/校验共用，
 * 记录近期运维目标、已完成动作与当前停留断点，确保无敏感凭据泄露。
 */

export const MAX_SERVER_CHECKPOINTS = 5;
export const CHECKPOINT_TITLE_MAX_LENGTH = 64;
export const CHECKPOINT_DONE_MAX_LENGTH = 300;
export const CHECKPOINT_NEXT_MAX_LENGTH = 200;

export const VALID_CHECKPOINT_STATUSES = ['in_progress', 'completed', 'interrupted'] as const;
export type CheckpointStatus = (typeof VALID_CHECKPOINT_STATUSES)[number];

export interface ServerTaskCheckpoint {
  id: number;
  user_id: number;
  server_id: number;
  title: string;
  status: CheckpointStatus;
  done_summary: string;
  next_step: string;
  created_at: number;
  updated_at: number;
}

const SENSITIVE_KEY_PATTERN =
  /^(.*_)?(password|passwd|secret|token|api_?key|auth_?token|credential|private_?key)(_.*)?$/i;

const SENSITIVE_VALUE_PATTERNS = [
  // 私钥与证书头
  /-----BEGIN\s+[A-Z\s]*PRIVATE\s+KEY-----/i,
  // 密码或凭证赋值（如 password=123、api_key: xyz）
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth_?token)\s*[:=]\s*[^\s]+/i,
  // 带有 Bearer token
  /bearer\s+[a-zA-Z0-9_.-]{16,}/i,
  // 常见已知前缀 Token（OpenAI、GitHub、Slack 等）
  /\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9]{10,})\b/i,
];

/** 检查文本内容是否包含敏感机密凭据 */
export function containsSensitiveData(...texts: string[]): boolean {
  for (const text of texts) {
    if (!text) continue;
    if (SENSITIVE_KEY_PATTERN.test(text.trim())) {
      return true;
    }
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }
  }
  return false;
}

export type CheckpointValidationError =
  | 'titleRequired'
  | 'titleTooLong'
  | 'doneRequired'
  | 'doneTooLong'
  | 'nextRequired'
  | 'nextTooLong'
  | 'invalidStatus'
  | 'sensitiveDataDetected';

export interface NormalizedCheckpointInput {
  title: string;
  status: CheckpointStatus;
  done_summary: string;
  next_step: string;
}

export type CheckpointInputResult =
  | { ok: true; value: NormalizedCheckpointInput }
  | { ok: false; error: CheckpointValidationError };

/**
 * 校验并规范化单条任务断点输入
 */
export function normalizeCheckpointInput(input: {
  title?: unknown;
  status?: unknown;
  done_summary?: unknown;
  next_step?: unknown;
}): CheckpointInputResult {
  if (typeof input.title !== 'string') return { ok: false, error: 'titleRequired' };
  const trimmedTitle = input.title.trim();
  if (!trimmedTitle) return { ok: false, error: 'titleRequired' };
  if ([...trimmedTitle].length > CHECKPOINT_TITLE_MAX_LENGTH) {
    return { ok: false, error: 'titleTooLong' };
  }

  if (typeof input.done_summary !== 'string') return { ok: false, error: 'doneRequired' };
  const trimmedDone = input.done_summary.trim();
  if (!trimmedDone) return { ok: false, error: 'doneRequired' };
  if ([...trimmedDone].length > CHECKPOINT_DONE_MAX_LENGTH) {
    return { ok: false, error: 'doneTooLong' };
  }

  if (typeof input.next_step !== 'string') return { ok: false, error: 'nextRequired' };
  const trimmedNext = input.next_step.trim();
  if (!trimmedNext) return { ok: false, error: 'nextRequired' };
  if ([...trimmedNext].length > CHECKPOINT_NEXT_MAX_LENGTH) {
    return { ok: false, error: 'nextTooLong' };
  }

  const status = (
    typeof input.status === 'string' &&
    VALID_CHECKPOINT_STATUSES.includes(input.status as CheckpointStatus)
      ? input.status
      : 'in_progress'
  ) as CheckpointStatus;

  if (containsSensitiveData(trimmedTitle, trimmedDone, trimmedNext)) {
    return { ok: false, error: 'sensitiveDataDetected' };
  }

  return {
    ok: true,
    value: {
      title: trimmedTitle,
      status,
      done_summary: trimmedDone,
      next_step: trimmedNext,
    },
  };
}
