/**
 * 服务器长期记忆档案（Server Memories / Dossier）共享校验模式。
 *
 * 供 Worker（/api/servers/:id/memories → UserDBDO）与 Agent 提取/校验共用，
 * 确保写入数据库与注入上下文的记忆均合规、受控且无敏感凭据泄露。
 */

export const MAX_SERVER_MEMORIES = 20;
export const MEMORY_KEY_MAX_LENGTH = 64;
export const MEMORY_VALUE_MAX_LENGTH = 512;

export const VALID_MEMORY_CATEGORIES = ['path', 'service', 'env', 'rule', 'custom'] as const;
export type ServerMemoryCategory = (typeof VALID_MEMORY_CATEGORIES)[number];

export const VALID_MEMORY_SOURCES = ['auto', 'manual'] as const;
export type ServerMemorySource = (typeof VALID_MEMORY_SOURCES)[number];

export interface ServerMemory {
  id: number;
  user_id: number;
  server_id: number;
  category: ServerMemoryCategory;
  fact_key: string;
  fact_value: string;
  source: ServerMemorySource;
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

/** 检查键名或事实内容是否包含敏感机密凭证 */
export function containsSensitiveData(key: string, value: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key.trim())) {
    return true;
  }
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export type MemoryValidationError =
  | 'keyRequired'
  | 'valueRequired'
  | 'keyTooLong'
  | 'valueTooLong'
  | 'invalidCategory'
  | 'invalidSource'
  | 'sensitiveDataDetected';

export interface NormalizedMemoryInput {
  category: ServerMemoryCategory;
  fact_key: string;
  fact_value: string;
  source: ServerMemorySource;
}

export type MemoryInputResult =
  | { ok: true; value: NormalizedMemoryInput }
  | { ok: false; error: MemoryValidationError };

/**
 * 校验并规范化单条记忆输入
 */
export function normalizeMemoryInput(input: {
  category?: unknown;
  fact_key?: unknown;
  fact_value?: unknown;
  source?: unknown;
}): MemoryInputResult {
  if (typeof input.fact_key !== 'string') return { ok: false, error: 'keyRequired' };
  const trimmedKey = input.fact_key.trim();
  if (!trimmedKey) return { ok: false, error: 'keyRequired' };
  if ([...trimmedKey].length > MEMORY_KEY_MAX_LENGTH) {
    return { ok: false, error: 'keyTooLong' };
  }

  if (typeof input.fact_value !== 'string') return { ok: false, error: 'valueRequired' };
  const trimmedValue = input.fact_value.trim();
  if (!trimmedValue) return { ok: false, error: 'valueRequired' };
  if ([...trimmedValue].length > MEMORY_VALUE_MAX_LENGTH) {
    return { ok: false, error: 'valueTooLong' };
  }

  const category = (
    typeof input.category === 'string' &&
    VALID_MEMORY_CATEGORIES.includes(input.category as ServerMemoryCategory)
      ? input.category
      : 'custom'
  ) as ServerMemoryCategory;

  const source = (
    typeof input.source === 'string' &&
    VALID_MEMORY_SOURCES.includes(input.source as ServerMemorySource)
      ? input.source
      : 'manual'
  ) as ServerMemorySource;

  if (containsSensitiveData(trimmedKey, trimmedValue)) {
    return { ok: false, error: 'sensitiveDataDetected' };
  }

  return {
    ok: true,
    value: {
      category,
      fact_key: trimmedKey,
      fact_value: trimmedValue,
      source,
    },
  };
}
