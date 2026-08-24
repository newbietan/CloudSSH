/**
 * 分享会话断线恢复的设备绑定挑战协议（前后端共享单一来源）。
 *
 * 客户端用认领时绑定的非可导出 ECDSA P-256 私钥对本模块构造的规范串签名，
 * 服务端（SSHSessionDO）以留存的 SPKI 公钥验签；nonce 单次消费防重放。
 * 本模块必须保持零依赖：同时被 Worker 与前端 Vite 构建引用，
 * 不能引入 Cloudflare 类型或 DOM 之外的运行时。
 */

/** 挑战串协议版本：格式变更时递增，服务端按当前版本验签。 */
export const RESUME_CHALLENGE_VERSION = 'v1';

/** 客户端时间戳与服务端时钟允许的最大偏斜；nonce 单次消费兜底重放。 */
export const RESUME_CHALLENGE_MAX_CLOCK_SKEW_MS = 120_000;

/** 规范挑战串：签名与验签双方必须使用完全一致的字符串。 */
export function buildResumeChallengeMessage(
  sessionId: string,
  nonce: string,
  timestamp: number
): string {
  return `cloudssh-resume:${RESUME_CHALLENGE_VERSION}:${sessionId}:${nonce}:${timestamp}`;
}
