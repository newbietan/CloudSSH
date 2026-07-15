// SSRF protection for user-supplied base_url

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
