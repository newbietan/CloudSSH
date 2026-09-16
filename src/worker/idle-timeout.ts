/**
 * 默认空闲会话超时时间：30 分钟（毫秒）
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 允许配置的正数超时最小保护下限：10 秒（毫秒）
 * 避免用户手误输入过小数值（如 1 或 1s）导致连接建立后瞬间断开。
 */
export const MIN_IDLE_TIMEOUT_MS = 10_000;

/**
 * 解析环境变量 IDLE_TIMEOUT 为毫秒数。
 *
 * 支持格式：
 * - 未设置 / null / 空字符串：返回默认值 30 分钟 (1,800,000 ms)
 * - "0" / "false" / "none" / "off"：返回 0（显式禁用空闲超时）
 * - 纯数字（如 "1800"）：默认按秒解析，返回 1800 * 1000 ms
 * - 带单位字符串：
 *   - "30m" / "30min" / "30mins" / "30minutes" -> 分钟
 *   - "1h" / "1hr" / "1hrs" / "1hour" / "1hours" -> 小时
 *   - "1800s" / "1800sec" / "1800secs" / "1800seconds" -> 秒
 *   - "1800000ms" -> 毫秒
 * - 无效输入（如非数字字符且无法识别）：降级为默认值 30 分钟
 * - 最小正数值保护：如果解析得到正数超时，强制至少为 10 秒
 */
export function parseIdleTimeout(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'none' || trimmed === 'off') {
    return 0;
  }

  const match = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/
  );
  if (!match) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }

  const num = Number.parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  if (num === 0) {
    return 0;
  }

  const unit = match[2] || 's';
  let ms: number;
  if (unit === 'ms') {
    ms = num;
  } else if (unit.startsWith('h')) {
    ms = num * 3600 * 1000;
  } else if (unit.startsWith('m')) {
    ms = num * 60 * 1000;
  } else {
    // 默认或 s/sec
    ms = num * 1000;
  }

  return Math.max(MIN_IDLE_TIMEOUT_MS, Math.floor(ms));
}
