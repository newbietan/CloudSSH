/**
 * 服务端 API 错误消息的本地化映射。
 *
 * Worker 内部的错误消息目前是英文常量（SSHShareDO / 路由层），直接透传到
 * 界面会破坏语言一致性。这里按精确消息文本映射到 i18n 词条；未命中的消息
 * 回退为原始文本（保留服务端细节），完全缺失时使用调用方指定兜底词条。
 * 未来若服务端引入结构化 code 字段，可在此优先按 code 匹配。
 */

import { type TranslationKey, t } from './i18n';

/** 已知服务端英文错误消息 → 词条键（与 src/worker/share-do.ts 的 jsonError 保持同步）。 */
const SERVER_MESSAGE_KEYS: Readonly<Record<string, TranslationKey>> = {
  'This share link has already been used or revoked': 'share.errorAlreadyUsed',
  'This share link has already been used': 'share.errorAlreadyUsed',
  'This share link has expired': 'share.errorLinkExpired',
  'Invalid share link': 'share.claimFailed',
  'Invalid request body': 'share.claimFailed',
  'Invalid device public key': 'share.claimFailed',
  'SSH sharing is disabled': 'share.errorSharingDisabled',
  'Share service unavailable': 'share.errorServiceUnavailable',
  'Connection ticket has already been used': 'share.errorAlreadyUsed',
  'Connection ticket expired': 'share.errorLinkExpired',
};

export interface ApiErrorPayload {
  error?: string;
}

/**
 * 把接口返回的错误负载转换为当前语言文案：
 * 已知消息 → 本地化词条；未知消息 → 透传原文（便于排查）；缺失 → 兜底词条。
 */
export function localizedApiError(payload: unknown, fallbackKey: TranslationKey): string {
  const message =
    typeof payload === 'object' && payload !== null
      ? (payload as ApiErrorPayload).error
      : undefined;
  if (!message) return t(fallbackKey);
  const mapped = SERVER_MESSAGE_KEYS[message];
  // 命中映射表时必须经 t() 翻译，直接返回键名会泄漏到界面（回归见 E2E share-session）
  return mapped ? t(mapped) : message;
}
