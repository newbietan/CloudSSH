/**
 * 服务器工作记录与上下文知识备忘（Server Memory: Work Logs & Context Knowledge）
 *
 * 规范化管理两类核心记忆：
 * 1. WorkLog（工作历程）：带时间锚点的活动日志（巡检、查看、升级、部署、排查等各类操作记录）
 * 2. KnowledgeItem（知识与凭据备忘）：用户主动告知或任务沉淀的密钥、Token、路径参数、业务规则等，
 *    供后续任务直接复用，避免重复索取。
 */

export const MAX_SERVER_WORK_LOGS = 10;
export const MAX_SERVER_KNOWLEDGE = 500;
export const MAX_BATCH_DELETE_KNOWLEDGE_IDS = 100;

/** 连续运维任务自动合并时间窗口（30分钟内视为连续排障/维护任务流） */
export const CONSECUTIVE_TASK_WINDOW_MS = 30 * 60 * 1000;

export const WORK_LOG_TITLE_MAX_LENGTH = 64;
export const WORK_LOG_SUMMARY_MAX_LENGTH = 300;

export const KNOWLEDGE_KEY_MAX_LENGTH = 64;
export const KNOWLEDGE_VALUE_MAX_LENGTH = 512;

export const VALID_KNOWLEDGE_CATEGORIES = ['credential', 'config', 'rule', 'note'] as const;
export type KnowledgeCategory = (typeof VALID_KNOWLEDGE_CATEGORIES)[number];

export interface ServerWorkLog {
  id: number;
  user_id: number;
  server_id: number;
  title: string;
  summary: string;
  created_at: number;
  updated_at: number;
}

export interface ServerKnowledgeItem {
  id: number;
  user_id: number;
  server_id: number;
  category: KnowledgeCategory;
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

export interface UnifiedServerMemory {
  workLogs: ServerWorkLog[];
  knowledge: ServerKnowledgeItem[];
}

const SENSITIVE_KEY_PATTERN =
  /^(.*_)?(password|passwd|secret|token|api_?key|auth_?token|credential|private_?key)(_.*)?$/i;

const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN\s+[A-Z\s]*PRIVATE\s+KEY-----/i,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth_?token)\s*[:=]\s*[^\s]+/i,
  /bearer\s+[a-zA-Z0-9_.-]{16,}/i,
  /\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9]{10,})\b/i,
];

/**
 * 判断键名或值是否属于机密凭据（用于 UI 默认脱敏掩码与分类推断）
 */
export function isSensitiveKeyOrValue(key: string, value: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key.trim())) return true;
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export type WorkLogMode = 'create' | 'update_latest';
export type KnowledgeAction = 'set' | 'delete';

export interface NormalizeWorkLogOptions {
  /** 超出长度上限时安全截断而非返回错误（用于 LLM 提炼输入容错） */
  truncate?: boolean;
}

/**
 * 校验并规范化工作记录输入
 */
export function normalizeWorkLogInput(
  input: {
    mode?: unknown;
    title?: unknown;
    summary?: unknown;
  },
  options?: NormalizeWorkLogOptions
): { ok: true; value: { mode: WorkLogMode; title: string; summary: string } } | { ok: false; error: string } {
  if (typeof input.title !== 'string') return { ok: false, error: 'titleRequired' };
  let trimmedTitle = input.title.trim();
  if (!trimmedTitle) return { ok: false, error: 'titleRequired' };
  if ([...trimmedTitle].length > WORK_LOG_TITLE_MAX_LENGTH) {
    if (options?.truncate) {
      trimmedTitle = [...trimmedTitle].slice(0, WORK_LOG_TITLE_MAX_LENGTH).join('');
    } else {
      return { ok: false, error: 'titleTooLong' };
    }
  }

  if (typeof input.summary !== 'string') return { ok: false, error: 'summaryRequired' };
  let trimmedSummary = input.summary.trim();
  if (!trimmedSummary) return { ok: false, error: 'summaryRequired' };
  if ([...trimmedSummary].length > WORK_LOG_SUMMARY_MAX_LENGTH) {
    if (options?.truncate) {
      trimmedSummary = [...trimmedSummary].slice(0, WORK_LOG_SUMMARY_MAX_LENGTH).join('');
    } else {
      return { ok: false, error: 'summaryTooLong' };
    }
  }

  const mode: WorkLogMode = input.mode === 'update_latest' ? 'update_latest' : 'create';

  return {
    ok: true,
    value: {
      mode,
      title: trimmedTitle,
      summary: trimmedSummary,
    },
  };
}

export interface NormalizeKnowledgeOptions {
  /** 超出长度上限时安全截断而非返回错误（用于 LLM 提炼输入容错） */
  truncate?: boolean;
}

/**
 * 校验并规范化知识与凭据输入
 */
export function normalizeKnowledgeInput(
  input: {
    action?: unknown;
    category?: unknown;
    key?: unknown;
    value?: unknown;
  },
  options?: NormalizeKnowledgeOptions
): {
  ok: true;
  value: { action: KnowledgeAction; category: KnowledgeCategory; key: string; value: string };
} | { ok: false; error: string } {
  if (typeof input.key !== 'string') return { ok: false, error: 'keyRequired' };
  const rawKey = input.key.trim();
  if (!rawKey) return { ok: false, error: 'keyRequired' };
  // Key 统一小写并将空白与连字符转为下划线，实现真正的实体对齐与去重
  const trimmedKey = rawKey.toLowerCase().replace(/[\s-]+/g, '_');
  if ([...trimmedKey].length > KNOWLEDGE_KEY_MAX_LENGTH) {
    return { ok: false, error: 'keyTooLong' };
  }

  const action: KnowledgeAction = input.action === 'delete' ? 'delete' : 'set';
  if (action === 'delete') {
    return {
      ok: true,
      value: {
        action: 'delete',
        category: 'note',
        key: trimmedKey,
        value: '',
      },
    };
  }

  if (typeof input.value !== 'string') return { ok: false, error: 'valueRequired' };
  let trimmedValue = input.value.trim();
  if (!trimmedValue) return { ok: false, error: 'valueRequired' };
  if ([...trimmedValue].length > KNOWLEDGE_VALUE_MAX_LENGTH) {
    if (options?.truncate) {
      trimmedValue = [...trimmedValue].slice(0, KNOWLEDGE_VALUE_MAX_LENGTH).join('');
    } else {
      return { ok: false, error: 'valueTooLong' };
    }
  }

  let category: KnowledgeCategory = 'note';
  if (
    typeof input.category === 'string' &&
    VALID_KNOWLEDGE_CATEGORIES.includes(input.category as KnowledgeCategory)
  ) {
    category = input.category as KnowledgeCategory;
  } else if (isSensitiveKeyOrValue(trimmedKey, trimmedValue)) {
    category = 'credential';
  }

  return {
    ok: true,
    value: {
      action: 'set',
      category,
      key: trimmedKey,
      value: trimmedValue,
    },
  };
}

/**
 * 校验并规范化批量删除知识输入
 */
export function normalizeBatchDeleteKnowledgeInput(input: unknown): {
  ok: true;
  value: { ids: number[] };
} | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalidBody' };
  const { ids } = input as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: 'idsRequired' };
  }
  if (ids.length > MAX_BATCH_DELETE_KNOWLEDGE_IDS) {
    return { ok: false, error: 'tooManyIds' };
  }
  const validIds: number[] = [];
  for (const id of ids) {
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
      validIds.push(id);
    } else {
      return { ok: false, error: 'invalidId' };
    }
  }
  if (validIds.length === 0) {
    return { ok: false, error: 'idsRequired' };
  }
  return { ok: true, value: { ids: Array.from(new Set(validIds)) } };
}

function getTimeParts(timestamp: number, timeZone?: string) {
  if (!timeZone) {
    const d = new Date(timestamp);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hours: d.getHours(),
      minutes: d.getMinutes(),
      seconds: d.getSeconds(),
      dayOfWeek: d.getDay(),
    };
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
      weekday: 'short',
    });
    const parts = formatter.formatToParts(new Date(timestamp));
    const map: Record<string, string> = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayOfWeek =
      days.includes(map.weekday) ? days.indexOf(map.weekday) : new Date(timestamp).getDay();
    return {
      year: parseInt(map.year, 10),
      month: parseInt(map.month, 10),
      day: parseInt(map.day, 10),
      hours: parseInt(map.hour, 10) === 24 ? 0 : parseInt(map.hour, 10),
      minutes: parseInt(map.minute, 10),
      seconds: parseInt(map.second, 10),
      dayOfWeek,
    };
  } catch {
    const d = new Date(timestamp);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hours: d.getHours(),
      minutes: d.getMinutes(),
      seconds: d.getSeconds(),
      dayOfWeek: d.getDay(),
    };
  }
}

/**
 * 格式化当前系统时间基准（供 Agent 计算相对日期）
 */
export function formatCurrentTimeAnchor(
  timestamp: number = Date.now(),
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  timeZone?: string
): string {
  const parts = getTimeParts(timestamp, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = parts.year;
  const m = pad(parts.month);
  const d = pad(parts.day);
  const hh = pad(parts.hours);
  const mm = pad(parts.minutes);
  const ss = pad(parts.seconds);

  const daysZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const daysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayStr = locale === 'en-US' ? daysEn[parts.dayOfWeek] : daysZh[parts.dayOfWeek];
  const tzSuffix = timeZone ? (locale === 'en-US' ? `, Timezone: ${timeZone}` : `, 时区: ${timeZone}`) : '';

  return `${y}-${m}-${d} ${hh}:${mm}:${ss} (${dayStr}${tzSuffix})`;
}

/**
 * 格式化记录时间并附带易读的相对时间描述（如：昨天、今天、3天前）
 */
export function formatTimestampWithRelative(
  timestamp: number,
  baseTimestamp: number = Date.now(),
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  timeZone?: string
): string {
  const isEn = locale === 'en-US';
  const targetParts = getTimeParts(timestamp, timeZone);
  const baseParts = getTimeParts(baseTimestamp, timeZone);

  const pad = (n: number) => String(n).padStart(2, '0');
  const y = targetParts.year;
  const m = pad(targetParts.month);
  const d = pad(targetParts.day);
  const hh = pad(targetParts.hours);
  const mm = pad(targetParts.minutes);

  const startOfTarget = new Date(Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day)).getTime();
  const startOfBase = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day)).getTime();
  const dayDiff = Math.round((startOfBase - startOfTarget) / 86_400_000);

  let relative = '';
  if (dayDiff === 0) {
    relative = isEn ? 'Today' : '今天';
  } else if (dayDiff === 1) {
    relative = isEn ? 'Yesterday' : '昨天';
  } else if (dayDiff === 2) {
    relative = isEn ? '2 days ago' : '前天';
  } else if (dayDiff > 2 && dayDiff <= 30) {
    relative = isEn ? `${dayDiff} days ago` : `${dayDiff}天前`;
  }

  return relative ? `${y}-${m}-${d} ${hh}:${mm} (${relative})` : `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 从 LLM 提炼返回的原始文本中健壮地提取 JSON 对象。
 *
 * 容错策略：
 * 1. 优先清洗显式思考标签 (<think>...</think>, <thought>...</thought>, <scratchpad>...</scratchpad>)，防止模型在思考阶段写出的草稿代码块干扰最终提取；
 * 2. 尝试从 Markdown 代码块提取 (```json ... ``` 或 ``` ... ```)；
 * 3. 寻找最外层大括号边界 { ... }，防御自然语言前缀/后序客套话与无代码块包裹；
 * 4. 原始解析兜底。
 */
export function extractDistillationJson(rawContent: string): any {
  if (!rawContent || typeof rawContent !== 'string') return null;

  const trimmed = rawContent.trim();
  if (!trimmed) return null;

  // 1. 优先清洗思考或中间过程标签，避免思考阶段输出的草稿代码块干扰最终提取
  const cleaned = trimmed
    .replace(/<(?:think|thought|scratchpad)>[\s\S]*?<\/(?:think|thought|scratchpad)>/gi, '')
    .trim();

  if (!cleaned) return null;

  // 2. 优先尝试从 Markdown 代码块提取
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 代码块解析失败则继续容错清洗 */
    }
  }

  // 3. 寻找最外层大括号边界 { ... }，防御自然语言前后缀客套话
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1).trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* ignore */
    }
  }

  // 4. 兜底原始解析
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    return null;
  }

  return null;
}

