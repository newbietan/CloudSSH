// SSRF protection for user-supplied base_url

import { checkHostResolved } from '../dns-check';

export function validateBaseUrl(baseUrl: string): { valid: boolean; reason?: string } {
  try {
    const url = new URL(baseUrl);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { valid: false, reason: '仅支持 http/https 协议' };
    }

    // url.hostname 对 IPv6 字面量返回带方括号的形式（如 "[::1]"），
    // 需剥离方括号再做比较，否则 IPv6 本地地址会绕过校验。
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return { valid: false, reason: '禁止访问 localhost' };
    }

    if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(hostname)) {
      return { valid: false, reason: '禁止访问内网地址' };
    }

    if (/^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:)/i.test(hostname)) {
      return { valid: false, reason: '禁止访问本地或内网 IPv6 地址' };
    }

    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return { valid: false, reason: '禁止访问云元数据服务' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: '无效的 URL 格式' };
  }
}

/**
 * Full SSRF validation: string-based check (fast, no network) + DNS
 * resolution check (catches rebinding where a domain resolves to an
 * internal IP). Should be called before any fetch() to a user-supplied
 * base_url.
 */
export async function validateBaseUrlWithDNS(
  baseUrl: string,
): Promise<{ valid: boolean; reason?: string }> {
  // First line: fast string-based check
  const stringCheck = validateBaseUrl(baseUrl);
  if (!stringCheck.valid) return stringCheck;

  // Second line: resolve hostname and verify resolved IPs
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname;
    const dnsCheck = await checkHostResolved(hostname);
    if (dnsCheck.blocked) {
      return { valid: false, reason: dnsCheck.reason };
    }
  } catch {
    // URL parsing already succeeded in validateBaseUrl, so this is unexpected
    return { valid: false, reason: 'SSRF 校验异常' };
  }

  return { valid: true };
}
