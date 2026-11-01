const TEAM_NAME_RE = /^[a-zA-Z0-9-]+$/;
const MAX_KEY_LEN = 16 * 1024;
const MAX_JWT_LEN = 8 * 1024;

function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/(bearer\s+)[a-zA-Z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/(token[:=]\s*)[a-zA-Z0-9._-]+/gi, '$1[REDACTED]');
}

export interface CfSshCaSignRequest {
  publicKey: string;
  teamName: string;
  token?: string;
}

export interface CfSshCaSignResponse {
  certificate: string;
  id?: string;
  expires_at?: string;
}

/**
 * 从入站请求中提取 Cloudflare Access JWT。
 * 优先读取 Cf-Access-Jwt-Assertion 头部，其次读取 Cookie 中的 CF_Authorization。
 */
export function extractAccessJwt(request: Request): string | null {
  const jwtHeader = request.headers.get('Cf-Access-Jwt-Assertion');
  if (jwtHeader && jwtHeader.trim().length > 0) {
    return jwtHeader.trim();
  }

  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const parts = cookie.trim().split('=');
      if (parts[0] === 'CF_Authorization' && parts[1]) {
        return parts[1].trim();
      }
    }
  }

  return null;
}

/**
 * 校验 Team Name 是否为合法的 Cloudflare Zero Trust 团队标识。
 */
export function sanitizeTeamName(teamName: string): string {
  const trimmed = teamName.trim().toLowerCase();
  // 兼容用户误填入完整域名 mycompany.cloudflareaccess.com
  const cleaned = trimmed.replace(/\.cloudflareaccess\.com$/, '').replace(/^https?:\/\//, '');
  if (!TEAM_NAME_RE.test(cleaned) || cleaned.length === 0 || cleaned.length > 64) {
    throw new Error('无效的 Cloudflare Zero Trust Team 名称');
  }
  return cleaned;
}

/**
 * 调用 Cloudflare Access 的 /cdn-cgi/access/cert_sign 接口签署 OpenSSH 短期证书。
 */
export async function signSshCertificateWithCloudflare(
  teamName: string,
  publicKey: string,
  jwt: string
): Promise<CfSshCaSignResponse> {
  const cleanTeam = sanitizeTeamName(teamName);
  const issuer = `https://${cleanTeam}.cloudflareaccess.com`;
  const endpoint = `${issuer}/cdn-cgi/access/cert_sign`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        public_key: publicKey.trim(),
        jwt: jwt.trim(),
        issuer,
      }),
      signal: controller.signal,
    });

    if (resp.status >= 300 && resp.status < 400) {
      throw new Error('Cloudflare CA 认证端点发生非预期的重定向');
    }

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => '');
      let message = `Cloudflare CA 签名失败 (${resp.status})`;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed.message) {
          message = `Cloudflare CA: ${parsed.message}`;
        }
      } catch {
        if (errorText.length > 0 && errorText.length < 200) {
          message = `Cloudflare CA: ${errorText}`;
        }
      }
      throw new Error(sanitizeErrorMessage(message));
    }

    const data = (await resp.json()) as any;
    if (!data || typeof data.certificate !== 'string') {
      throw new Error('Cloudflare CA 返回的证书格式异常');
    }

    return {
      certificate: data.certificate,
      id: data.id,
      expires_at: data.expires_at,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 处理 POST /api/cf-ssh-ca/sign 路由。
 */
export async function handleCloudflareSshCaSign(request: Request): Promise<Response> {
  let body: CfSshCaSignRequest;
  try {
    body = await request.json<CfSshCaSignRequest>();
  } catch {
    return Response.json({ error: '无效的 JSON 请求正文' }, { status: 400 });
  }

  if (!body.publicKey || typeof body.publicKey !== 'string' || body.publicKey.length > MAX_KEY_LEN) {
    return Response.json({ error: '缺少或无效的 SSH 公钥' }, { status: 400 });
  }

  let cleanTeam: string;
  try {
    cleanTeam = sanitizeTeamName(body.teamName || '');
  } catch (err: any) {
    return Response.json({ error: err.message || '无效的 Team 名称' }, { status: 400 });
  }

  const jwt = (body.token && body.token.trim()) || extractAccessJwt(request);
  if (!jwt) {
    return Response.json(
      {
        error: '未检测到 Cloudflare Access 身份凭据，请在保护域名下访问或先完成 Zero Trust 认证',
      },
      { status: 401 }
    );
  }

  if (jwt.length > MAX_JWT_LEN) {
    return Response.json({ error: 'Access Token 长度超出安全限制' }, { status: 400 });
  }

  try {
    const result = await signSshCertificateWithCloudflare(cleanTeam, body.publicKey, jwt);
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ error: err.message || '申请证书失败' }, { status: 502 });
  }
}
