// SSRF protection for user-supplied base_url

export function validateBaseUrl(baseUrl: string): { valid: boolean; reason?: string } {
  try {
    const url = new URL(baseUrl);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { valid: false, reason: '仅支持 http/https 协议' };
    }

    const hostname = url.hostname.toLowerCase();

    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return { valid: false, reason: '禁止访问 localhost' };
    }

    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) {
      return { valid: false, reason: '禁止访问内网地址' };
    }

    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return { valid: false, reason: '禁止访问云元数据服务' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: '无效的 URL 格式' };
  }
}
