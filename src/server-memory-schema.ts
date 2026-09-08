/**
 * 服务器工作记录与上下文知识备忘（Server Memory: Work Logs & Context Knowledge）
 *
 * 规范化管理两类核心记忆：
 * 1. WorkLog（工作历程）：带时间锚点的活动日志（巡检、查看、升级、部署、排查等各类操作记录）
 * 2. KnowledgeItem（知识与凭据备忘）：用户主动告知或任务沉淀的密钥、Token、路径参数、业务规则等，
 *    供后续任务直接复用，避免重复索取。
 */

export const MAX_SERVER_WORK_LOGS = 10;
export const MAX_SERVER_KNOWLEDGE = 20;

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

/**
 * 校验并规范化工作记录输入
 */
export function normalizeWorkLogInput(input: {
  title?: unknown;
  summary?: unknown;
}): { ok: true; value: { title: string; summary: string } } | { ok: false; error: string } {
  if (typeof input.title !== 'string') return { ok: false, error: 'titleRequired' };
  const trimmedTitle = input.title.trim();
  if (!trimmedTitle) return { ok: false, error: 'titleRequired' };
  if ([...trimmedTitle].length > WORK_LOG_TITLE_MAX_LENGTH) {
    return { ok: false, error: 'titleTooLong' };
  }

  if (typeof input.summary !== 'string') return { ok: false, error: 'summaryRequired' };
  const trimmedSummary = input.summary.trim();
  if (!trimmedSummary) return { ok: false, error: 'summaryRequired' };
  if ([...trimmedSummary].length > WORK_LOG_SUMMARY_MAX_LENGTH) {
    return { ok: false, error: 'summaryTooLong' };
  }

  return {
    ok: true,
    value: {
      title: trimmedTitle,
      summary: trimmedSummary,
    },
  };
}

/**
 * 校验并规范化知识与凭据输入
 */
export function normalizeKnowledgeInput(input: {
  category?: unknown;
  key?: unknown;
  value?: unknown;
}): { ok: true; value: { category: KnowledgeCategory; key: string; value: string } } | { ok: false; error: string } {
  if (typeof input.key !== 'string') return { ok: false, error: 'keyRequired' };
  const trimmedKey = input.key.trim();
  if (!trimmedKey) return { ok: false, error: 'keyRequired' };
  if ([...trimmedKey].length > KNOWLEDGE_KEY_MAX_LENGTH) {
    return { ok: false, error: 'keyTooLong' };
  }

  if (typeof input.value !== 'string') return { ok: false, error: 'valueRequired' };
  const trimmedValue = input.value.trim();
  if (!trimmedValue) return { ok: false, error: 'valueRequired' };
  if ([...trimmedValue].length > KNOWLEDGE_VALUE_MAX_LENGTH) {
    return { ok: false, error: 'valueTooLong' };
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
      category,
      key: trimmedKey,
      value: trimmedValue,
    },
  };
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
  } else {
    relative = `${y}-${m}-${d}`;
  }

  return `${y}-${m}-${d} ${hh}:${mm} (${relative})`;
}
