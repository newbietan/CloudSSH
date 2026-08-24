import { normalizeThemeData, THEME_MAX_BYTES } from '../theme-schema';
import { ALLOWED_LOCATION_HINTS, type Env, type SSHConnectionConfig } from '../types';
import {
  getAuthenticatedUser,
  handleGetMe,
  handleGitHubAuth,
  handleGitHubCallback,
  handleLogout,
  isGitHubAuthRequired,
  isGitHubUserAllowed,
} from './auth';
import { HTML } from './html';

export { SSHSessionDO } from './durable-object';
export { SSHShareDO } from './share-do';
export { UserDBDO } from './user-db';

const RATE_LIMIT_MAX = 10; // max requests per window
const RATE_LIMIT_WINDOW = 60000; // 1 minute window
const RATE_LIMIT_MAX_ENTRIES = 10000;
const RATE_LIMIT_CLEANUP_INTERVAL = 256;

// Worker 实例级削峰；Turnstile 和一次性 token 仍负责实际连接鉴权。
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
let rateLimitChecks = 0;

function cleanExpiredRateLimits(now: number): void {
  for (const [ip, record] of rateLimitMap) {
    if (now >= record.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
}

function getRateLimitRetryAfter(ip: string | null): number | null {
  if (!ip) return null;

  const now = Date.now();
  rateLimitChecks++;
  if (rateLimitChecks % RATE_LIMIT_CLEANUP_INTERVAL === 0) {
    cleanExpiredRateLimits(now);
  }

  let record = rateLimitMap.get(ip);

  if (!record || now >= record.resetAt) {
    if (!record && rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      const oldestIP = rateLimitMap.keys().next().value;
      if (oldestIP !== undefined) rateLimitMap.delete(oldestIP);
    }
    record = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, record);
    return null;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((record.resetAt - now) / 1000));
  }

  record.count++;
  return null;
}

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${secret}&response=${token}&remoteip=${ip}`,
    });
    const result = await response.json<{ success: boolean }>();
    return result.success === true;
  } catch {
    return false;
  }
}

// --- Simple token-based verification for session-level ---
const VERIFIED_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours (fallback for token validation)

async function generateVerifiedToken(secret: string): Promise<string> {
  const expires = Date.now() + VERIFIED_TOKEN_TTL;
  const payload = `${expires}`;

  // 使用 HMAC-SHA256 进行签名
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));

  // 转换为十六进制字符串
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `${payload}:${signatureHex}`;
}

async function isVerifiedTokenValid(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split(':');
    if (parts.length !== 2) return false;

    const [expiresStr, signature] = parts;
    if (!/^\d+$/.test(expiresStr) || !/^[0-9a-f]{64}$/i.test(signature)) return false;

    const expires = Number(expiresStr);
    if (!Number.isSafeInteger(expires) || Date.now() > expires) return false;

    // 使用 HMAC-SHA256 验证签名
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    // 将十六进制签名转换回字节数组
    const signatureBytes = new Uint8Array(
      signature.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))
    );

    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(expiresStr)
    );
  } catch {
    return false;
  }
}

// --- UserDBDO helper ---
function getUserDBStub(env: Env, githubId: string | number): DurableObjectStub {
  const id = env.USER_DB.idFromName(githubId.toString());
  return env.USER_DB.get(id);
}

function isSSHSharingEnabled(env: Env): boolean {
  return env.ENABLE_SSH_SHARING === 'true';
}

async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * 校验 locationHint 值是否在 Cloudflare DO 允许的列表内（白名单）。
 * 返回符合规范的 hint 字符串；非法/空值返回 undefined（DO get() 退化为默认调度）。
 */
function validateRegion(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  return (ALLOWED_LOCATION_HINTS as readonly string[]).includes(v) ? v : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // ==================== Auth Routes ====================

      if (url.pathname === '/api/auth/github') {
        return handleGitHubAuth(request, env);
      }

      if (url.pathname === '/api/auth/callback') {
        return handleGitHubCallback(request, env);
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        return handleLogout(request, env);
      }

      if (url.pathname === '/api/auth/me') {
        return handleGetMe(request, env);
      }

      // ==================== 一次性 SSH 分享公开兑换 ====================

      if (url.pathname === '/api/share/claim' && request.method === 'POST') {
        return handleShareClaim(request, url, env);
      }

      // ==================== 分享管理与审计（需认证） ====================

      if (url.pathname.startsWith('/api/shares/')) {
        return handleShareOwnerRoute(request, url, env);
      }

      // ==================== Servers Routes (需认证) ====================

      if (url.pathname === '/api/servers' || url.pathname.startsWith('/api/servers/')) {
        return handleServersRoute(request, url, env);
      }

      // ==================== Theme Routes（登录用户跨环境同步） ====================

      if (url.pathname === '/api/user/theme') {
        return handleThemeRoute(request, env);
      }

      // ==================== known_hosts Routes (需认证) ====================

      if (url.pathname === '/api/known-hosts' || url.pathname.startsWith('/api/known-hosts/')) {
        return handleKnownHostsRoute(request, url, env);
      }

      // ==================== 命令片段 Routes (需认证) ====================

      if (url.pathname === '/api/snippets' || url.pathname.startsWith('/api/snippets/')) {
        return handleSnippetsRoute(request, url, env);
      }

      // ==================== AI Config Routes (需认证) ====================

      if (url.pathname === '/api/ai/config' || url.pathname === '/api/ai/models') {
        return handleAIRoute(request, url, env);
      }

      // ==================== Turnstile Verify ====================

      if (url.pathname === '/api/verify' && request.method === 'POST') {
        if (!env.TURNSTILE_SECRET) {
          return Response.json({ success: true });
        }

        const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
        const body = await request.json<{ token: string }>();

        if (!body.token) {
          return Response.json({ success: false, error: 'Missing token' }, { status: 400 });
        }

        const isValid = await verifyTurnstile(body.token, env.TURNSTILE_SECRET, clientIP);
        if (!isValid) {
          return Response.json({ success: false, error: 'Invalid token' }, { status: 403 });
        }

        // Issue a verified token as a session cookie (no Max-Age = session cookie, expires when browser closes)
        const verifiedToken = await generateVerifiedToken(env.TURNSTILE_SECRET);
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `cf_verified=${verifiedToken}; Path=/; HttpOnly; Secure; SameSite=Strict`,
          },
        });
      }

      // ==================== SSH WebSocket ====================

      if (url.pathname === '/api/ssh/sftp') {
        return handleSFTPAttachConnection(request, env);
      }

      if (url.pathname === '/api/ssh') {
        const clientIP = request.headers.get('CF-Connecting-IP');
        const retryAfter = getRateLimitRetryAfter(clientIP);
        if (retryAfter !== null) {
          return new Response('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': String(retryAfter) },
          });
        }

        // Check for resume-token (session re-attach)
        const resumeToken = url.searchParams.get('resume_token');
        const resumeSession = url.searchParams.get('session');
        if (resumeToken && resumeSession) {
          return handleResumeSSHConnection(request, env, resumeSession, resumeToken);
        }

        // Check for one-time-token (from server management connect)
        const connectToken = url.searchParams.get('token');
        if (connectToken) {
          return handleTokenSSHConnection(request, env, connectToken);
        }
        const shareRef = url.searchParams.get('share_ref');
        const shareTicket = url.searchParams.get('share_ticket');
        if (shareRef || shareTicket) {
          if (!shareRef || !shareTicket) {
            return Response.json({ error: 'Missing share connection ticket' }, { status: 403 });
          }
          return handleShareSSHConnection(request, env, shareRef, shareTicket);
        }

        // Verify Turnstile if secret is configured
        if (env.TURNSTILE_SECRET) {
          // Check if user has a valid verification cookie
          const cookies = request.headers.get('Cookie') || '';
          const verifiedCookie = cookies
            .split(';')
            .find((c) => c.trim().startsWith('cf_verified='));
          const verifiedToken = verifiedCookie?.split('=')[1];

          if (
            !verifiedToken ||
            !(await isVerifiedTokenValid(verifiedToken, env.TURNSTILE_SECRET))
          ) {
            // No valid cookie, check Turnstile token
            const turnstileToken = url.searchParams.get('turnstile_token');
            if (!turnstileToken) {
              return Response.json({ error: 'Missing Turnstile token' }, { status: 403 });
            }
            const isValid = await verifyTurnstile(
              turnstileToken,
              env.TURNSTILE_SECRET,
              clientIP || ''
            );
            if (!isValid) {
              return Response.json({ error: 'Turnstile verification failed' }, { status: 403 });
            }
          }
        }

        return handleSSHConnection(request, env);
      }

      if (url.pathname === '/api/health') {
        return Response.json({ status: 'ok', timestamp: Date.now() });
      }

      // Return config info (includes GitHub auth availability)
      if (url.pathname === '/api/config') {
        return Response.json({
          turnstileEnabled: !!env.TURNSTILE_SECRET,
          sitekey: env.TURNSTILE_SITEKEY || '',
          githubAuthEnabled: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
          githubAuthRequired: isGitHubAuthRequired(env),
          sshSharingEnabled: isSSHSharingEnabled(env),
        });
      }

      return new Response(HTML, {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Unhandled error in fetch handler:', msg);
      return Response.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  },
};

// ==================== Server management routes ====================

async function handleServersRoute(request: Request, url: URL, env: Env): Promise<Response> {
  // 认证检查
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env, user.github_id);

  // GET /api/servers
  if (url.pathname === '/api/servers' && request.method === 'GET') {
    return stub.fetch(
      new Request(`http://internal/internal/servers?user_id=${user.id}`, {
        method: 'GET',
      })
    );
  }

  // POST /api/servers
  if (url.pathname === '/api/servers' && request.method === 'POST') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  // /api/servers/:id/connect
  const sharesMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/shares$/);
  if (sharesMatch) {
    if (!isSSHSharingEnabled(env)) {
      return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
    }
    const serverId = sharesMatch[1];
    if (request.method === 'GET') {
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/shares?user_id=${user.id}`, {
          method: 'GET',
        })
      );
    }
    if (request.method === 'POST') {
      const body = await request.json<{ expiresInMinutes?: number; maxSessionMinutes?: number }>();
      const expiresInMinutes = Number(body.expiresInMinutes);
      const maxSessionMinutes = Number(body.maxSessionMinutes);
      if (![5, 15, 30, 60].includes(expiresInMinutes)) {
        return Response.json({ error: 'Invalid share expiry' }, { status: 400 });
      }
      if (![15, 30, 60, 120].includes(maxSessionMinutes)) {
        return Response.json({ error: 'Invalid maximum session duration' }, { status: 400 });
      }

      const token = createShareToken();
      const shareRef = await hashShareToken(token);
      const shareId = crypto.randomUUID();
      const expiresAt = Date.now() + expiresInMinutes * 60_000;
      const metadataResponse = await stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}/shares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: user.id,
            share_id: shareId,
            share_ref: shareRef,
            expires_at: expiresAt,
            max_session_seconds: maxSessionMinutes * 60,
          }),
        })
      );
      if (!metadataResponse.ok) return metadataResponse;
      const metadata = await metadataResponse.json<{
        serverName: string;
        expiresAt: number;
        maxSessionSeconds: number;
      }>();

      const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
      const initResponse = await shareStub.fetch(
        new Request('http://internal/internal/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shareId,
            tokenHash: shareRef,
            ownerUserId: user.id,
            ownerGithubId: String(user.github_id),
            serverId: Number(serverId),
            serverName: metadata.serverName,
            expiresAt,
            maxSessionSeconds: maxSessionMinutes * 60,
          }),
        })
      );
      if (!initResponse.ok) {
        await stub
          .fetch(
            new Request(`http://internal/internal/shares/${shareId}/status`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: user.id, status: 'revoked', closed_at: Date.now() }),
            })
          )
          .catch(() => null);
        return Response.json({ error: 'Failed to initialize share link' }, { status: 500 });
      }
      return Response.json(
        {
          id: shareId,
          url: `${url.origin}/#/share/${token}`,
          expiresAt,
          maxSessionSeconds: maxSessionMinutes * 60,
        },
        { status: 201 }
      );
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  // /api/servers/:id/connect
  const connectMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/connect$/);
  if (connectMatch && request.method === 'POST') {
    const serverId = connectMatch[1];
    const tokenRes = await stub.fetch(
      new Request(`http://internal/internal/servers/${serverId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id }),
      })
    );

    if (!tokenRes.ok) return tokenRes;

    const { token } = await tokenRes.json<{ token: string }>();
    const wsUrl = `wss://${url.host}/api/ssh?token=${token}`;

    return Response.json({ wsUrl });
  }

  // /api/servers/:id
  const serverMatch = url.pathname.match(/^\/api\/servers\/(\d+)$/);
  if (serverMatch) {
    const serverId = serverMatch[1];

    // PUT /api/servers/:id
    if (request.method === 'PUT') {
      const body = await request.json<Record<string, unknown>>();
      body.user_id = user.id;
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }

    // DELETE /api/servers/:id
    if (request.method === 'DELETE') {
      return stub.fetch(
        new Request(`http://internal/internal/servers/${serverId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: user.id }),
        })
      );
    }
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}

// ==================== Theme routes ====================

async function handleThemeRoute(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env, user.github_id);

  if (request.method === 'GET') {
    return stub.fetch(
      new Request(`http://internal/internal/theme?user_id=${user.id}`, {
        method: 'GET',
      })
    );
  }

  if (request.method === 'PUT') {
    let body: Record<string, unknown>;
    try {
      body = await request.json<Record<string, unknown>>();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const rawThemeData = body.theme_data;
    if (!rawThemeData || typeof rawThemeData !== 'object' || Array.isArray(rawThemeData)) {
      return Response.json({ error: 'Invalid theme data' }, { status: 400 });
    }
    const rawSerializedTheme = JSON.stringify(rawThemeData);
    if (new TextEncoder().encode(rawSerializedTheme).byteLength > THEME_MAX_BYTES) {
      return Response.json({ error: 'Theme data is too large' }, { status: 413 });
    }
    const themeData = normalizeThemeData(rawThemeData);
    if (!themeData) {
      return Response.json({ error: 'Invalid theme data' }, { status: 400 });
    }
    const serializedTheme = JSON.stringify(themeData);
    return stub.fetch(
      new Request('http://internal/internal/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id, theme_data: serializedTheme }),
      })
    );
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ==================== known_hosts routes ====================

async function handleKnownHostsRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env, user.github_id);

  // GET /api/known-hosts?host=X&port=Y  → 获取特定主机指纹
  // GET /api/known-hosts                 → 列出所有已知主机
  if (request.method === 'GET') {
    const host = url.searchParams.get('host');
    const port = url.searchParams.get('port');
    const qs = new URLSearchParams({ user_id: String(user.id) });
    if (host) qs.set('host', host);
    if (port) qs.set('port', port);
    return stub.fetch(
      new Request(`http://internal/internal/known-hosts?${qs}`, {
        method: 'GET',
      })
    );
  }

  // POST /api/known-hosts  → 存储/更新主机指纹
  if (request.method === 'POST') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/known-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  // DELETE /api/known-hosts  → 删除主机指纹
  if (request.method === 'DELETE') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/known-hosts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ==================== 命令片段 routes ====================

async function handleSnippetsRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  const stub = getUserDBStub(env, user.github_id);
  if (url.pathname === '/api/snippets' && request.method === 'GET') {
    return stub.fetch(
      new Request(`http://internal/internal/snippets?user_id=${user.id}`, { method: 'GET' })
    );
  }
  if (url.pathname === '/api/snippets' && request.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await request.json<Record<string, unknown>>();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    body.user_id = user.id;
    return stub.fetch(
      new Request('http://internal/internal/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }
  const snippetMatch = url.pathname.match(/^\/api\/snippets\/(\d+)$/);
  if (snippetMatch) {
    const snippetId = snippetMatch[1];
    if (request.method === 'PUT') {
      let body: Record<string, unknown>;
      try {
        body = await request.json<Record<string, unknown>>();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      body.user_id = user.id;
      return stub.fetch(
        new Request(`http://internal/internal/snippets/${snippetId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }
    if (request.method === 'DELETE') {
      return stub.fetch(
        new Request(`http://internal/internal/snippets/${snippetId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: user.id }),
        })
      );
    }
  }
  return Response.json({ error: 'Not Found' }, { status: 404 });
}

// ==================== AI config routes ====================

async function handleAIRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env, user.github_id);

  // GET /api/ai/config — return current AI config (masked)
  if (url.pathname === '/api/ai/config' && request.method === 'GET') {
    return stub.fetch(
      new Request(`http://internal/internal/ai-config?user_id=${user.id}`, {
        method: 'GET',
      })
    );
  }

  // PUT /api/ai/config — save AI config
  if (url.pathname === '/api/ai/config' && request.method === 'PUT') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;

    // SSRF validation for base_url
    if (body.base_url) {
      const { validateBaseUrlWithDNS } = await import('./agent/ssrf');
      const check = await validateBaseUrlWithDNS(body.base_url as string);
      if (!check.valid) {
        return Response.json({ error: check.reason }, { status: 400 });
      }
    }

    return stub.fetch(
      new Request('http://internal/internal/ai-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  // POST /api/ai/models — proxy model list from user's LLM provider
  if (url.pathname === '/api/ai/models' && request.method === 'POST') {
    const { base_url, api_key } = await request.json<{ base_url: string; api_key: string }>();

    if (!base_url || !api_key) {
      return Response.json({ error: 'Missing base_url or api_key' }, { status: 400 });
    }

    // SSRF validation
    const { validateBaseUrlWithDNS } = await import('./agent/ssrf');
    const check = await validateBaseUrlWithDNS(base_url);
    if (!check.valid) {
      return Response.json({ error: check.reason }, { status: 400 });
    }

    try {
      let cleanBaseUrl = base_url.replace(/\/$/, '');
      if (cleanBaseUrl.endsWith('/chat/completions')) {
        cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length);
      }
      const modelsUrl = `${cleanBaseUrl}/models`;

      const res = await fetch(modelsUrl, {
        redirect: 'manual', // Cloudflare Workers only supports 'follow' or 'manual'
        headers: {
          Authorization: `Bearer ${api_key}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (res.status >= 300 && res.status < 400) {
        return Response.json(
          { error: 'SSRF Protection: Redirects are not allowed' },
          { status: 403 }
        );
      }

      if (!res.ok) {
        if (res.status === 404) {
          return Response.json({
            models: [],
            fallback: true,
            reason: 'Provider does not support /models endpoint',
          });
        }
        if (res.status === 401 || res.status === 403) {
          return Response.json(
            { error: 'API Key invalid or insufficient permissions' },
            { status: res.status }
          );
        }
        return Response.json({ error: `Provider returned ${res.status}` }, { status: 502 });
      }

      const data = (await res.json()) as any;

      let rawModels: any[] = [];
      if (Array.isArray(data)) {
        rawModels = data;
      } else if (data && Array.isArray(data.data)) {
        rawModels = data.data;
      } else if (data && Array.isArray(data.models)) {
        rawModels = data.models;
      }

      const models: Array<{ id: string }> = rawModels
        .filter((m: any) => {
          const id = m.id || '';
          return !/embedding|whisper|tts|dall-e|moderation|rerank/i.test(id);
        })
        .map((m: any) => ({ id: m.id }))
        .sort((a: any, b: any) => a.id.localeCompare(b.id));

      return Response.json({ models, fallback: false });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return Response.json({ models: [], fallback: true, reason: errMsg });
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ==================== SSH connection handlers ====================

function parseRequestUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function hasSameWebSocketOrigin(request: Request, url: URL): boolean {
  return request.headers.get('Origin') === url.origin;
}

async function handleSSHConnection(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });

  // Prevent Cross-Site WebSocket Hijacking / Quota Leeching
  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (isGitHubAuthRequired(env) && !(await getAuthenticatedUser(request, env))) {
    return Response.json({ error: 'GitHub authentication required' }, { status: 401 });
  }

  const sessionName = `session:${Date.now()}:${Math.random()}`;
  const doId = env.SSH_SESSION.idFromName(sessionName);
  // 匿名路径不做自动推断（Worker 在 upgrade 时拿不到 host）；
  // 仅尊重用户通过前端下拉手动传入的 ?region= 覆盖值
  const region = validateRegion(url.searchParams.get('region'));
  const stub = region
    ? env.SSH_SESSION.get(doId, { locationHint: region } as any)
    : env.SSH_SESSION.get(doId);

  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.set('session', sessionName);

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.delete('x-ssh-config'); // 防御：禁止匿名连接通过 HTTP 头注入配置

  return stub.fetch(new Request(doUrl.toString(), { headers }));
}

/**
 * 处理会话秒级断线重连 (Session Re-attach)
 * 流程：通过 sessionName 路由至原 DO 实例，并附带 resumeToken 鉴权
 */
async function handleResumeSSHConnection(
  request: Request,
  env: Env,
  sessionName: string,
  resumeToken: string
): Promise<Response> {
  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });

  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  // 与 direct / one-time-token 升级路径保持一致的强制 GitHub 登录门禁：
  // REQUIRE_GITHUB_AUTH=true 时 resume 凭据不能替代有效会话。
  if (isGitHubAuthRequired(env) && !(await getAuthenticatedUser(request, env))) {
    return Response.json({ error: 'GitHub authentication required' }, { status: 401 });
  }

  const doId = env.SSH_SESSION.idFromName(sessionName);
  const stub = env.SSH_SESSION.get(doId);

  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.set('session', sessionName);
  doUrl.searchParams.set('resume_token', resumeToken);

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.delete('x-ssh-config');

  return stub.fetch(new Request(doUrl.toString(), { headers }));
}

async function handleShareClaim(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isSSHSharingEnabled(env)) {
    return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
  }
  const retryAfter = getRateLimitRetryAfter(request.headers.get('CF-Connecting-IP'));
  if (retryAfter !== null) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    });
  }
  let body: { token?: string; devicePubKey?: string };
  try {
    body = await request.json<{ token?: string; devicePubKey?: string }>();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(body.token)) {
    return Response.json({ error: 'Invalid share link' }, { status: 400 });
  }
  // 可选的设备绑定公钥（SPKI base64url）；格式非法时直接拒绝，避免静默降级。
  if (
    body.devicePubKey !== undefined &&
    (typeof body.devicePubKey !== 'string' || !/^[A-Za-z0-9_-]{80,600}$/.test(body.devicePubKey))
  ) {
    return Response.json({ error: 'Invalid device public key' }, { status: 400 });
  }
  const shareRef = await hashShareToken(body.token);
  const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
  const claimResponse = await shareStub.fetch(
    new Request('http://internal/internal/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: body.token, devicePubKey: body.devicePubKey }),
    })
  );
  if (!claimResponse.ok) return claimResponse;
  const claim = await claimResponse.json<{
    ticket: string;
    serverName: string;
    sessionExpiresAt: number;
  }>();
  return Response.json({
    wsUrl: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/api/ssh?share_ref=${encodeURIComponent(shareRef)}&share_ticket=${encodeURIComponent(claim.ticket)}`,
    serverName: claim.serverName,
    sessionExpiresAt: claim.sessionExpiresAt,
  });
}

async function handleShareOwnerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isSSHSharingEnabled(env)) {
    return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
  }
  const user = await getAuthenticatedUser(request, env);
  if (!user) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const match = url.pathname.match(/^\/api\/shares\/([^/]+)(?:\/audit)?$/);
  if (!match) return new Response('Not Found', { status: 404 });
  const shareId = decodeURIComponent(match[1]);
  const ownerStub = getUserDBStub(env, user.github_id);
  const metadataResponse = await ownerStub.fetch(
    new Request(
      `http://internal/internal/shares/${encodeURIComponent(shareId)}?user_id=${user.id}`,
      { method: 'GET' }
    )
  );
  if (!metadataResponse.ok) return metadataResponse;
  const metadata = await metadataResponse.json<{ shareRef: string }>();
  const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(metadata.shareRef));

  if (url.pathname.endsWith('/audit') && request.method === 'GET') {
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    return shareStub.fetch(
      new Request(
        `http://internal/internal/owner-view?owner_user_id=${user.id}&after=${after}&limit=${limit}`,
        { method: 'GET' }
      )
    );
  }
  if (!url.pathname.endsWith('/audit') && request.method === 'DELETE') {
    return shareStub.fetch(new Request('http://internal/internal/revoke', { method: 'POST' }));
  }
  return new Response('Method Not Allowed', { status: 405 });
}

async function handleShareSSHConnection(
  request: Request,
  env: Env,
  shareRef: string,
  ticket: string
): Promise<Response> {
  if (!isSSHSharingEnabled(env)) {
    return Response.json({ error: 'SSH sharing is disabled' }, { status: 404 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }
  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  if (!hasSameWebSocketOrigin(request, url)) return new Response('Forbidden', { status: 403 });
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(shareRef) || !/^[A-Za-z0-9_-]{40,128}$/.test(ticket)) {
    return Response.json({ error: 'Invalid share connection ticket' }, { status: 400 });
  }

  const sessionName = `share-session:${crypto.randomUUID()}`;
  const shareStub = env.SSH_SHARE.get(env.SSH_SHARE.idFromName(shareRef));
  const configResponse = await shareStub.fetch(
    new Request('http://internal/internal/connect/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, sessionName }),
    })
  );
  if (!configResponse.ok) return configResponse;
  const { config, devicePubKey } = await configResponse.json<{
    config: SSHConnectionConfig;
    serverName: string;
    devicePubKey?: string | null;
  }>();
  if (!config.sessionPolicy || config.sessionPolicy.shareRef !== shareRef) {
    return Response.json({ error: 'Invalid share session policy' }, { status: 500 });
  }
  if (!isGitHubUserAllowed(env, config.githubId ?? '')) {
    return Response.json({ error: 'Share owner is no longer allowed' }, { status: 403 });
  }

  const doId = env.SSH_SESSION.idFromName(sessionName);
  const hint = validateRegion(config.locationHint);
  const sessionStub = hint
    ? env.SSH_SESSION.get(doId, { locationHint: hint } as any)
    : env.SSH_SESSION.get(doId);
  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.delete('share_ref');
  doUrl.searchParams.delete('share_ticket');
  doUrl.searchParams.set('session', sessionName);
  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.set('x-ssh-config', encodeURIComponent(JSON.stringify(config)));
  // 认领时绑定的设备公钥由服务端链路下发（claim → ShareDO → consume），
  // 客户端无法注入或替换，断线恢复时以此验签。
  if (typeof devicePubKey === 'string' && devicePubKey) {
    headers.set('x-share-device-key', devicePubKey);
  }
  return sessionStub.fetch(new Request(doUrl.toString(), { headers }));
}

/**
 * 处理通过 one-time-token 发起的 SSH 连接
 * 流程：从 UserDBDO 消费 token 获取凭据 → 传给 SSHSessionDO
 */
async function handleTokenSSHConnection(
  request: Request,
  env: Env,
  token: string
): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });

  // Prevent Cross-Site WebSocket Hijacking
  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  const githubAuthRequired = isGitHubAuthRequired(env);
  const authenticatedUser = githubAuthRequired ? await getAuthenticatedUser(request, env) : null;
  if (githubAuthRequired && !authenticatedUser) {
    return Response.json({ error: 'GitHub authentication required' }, { status: 401 });
  }

  // 从 UserDBDO 消费 token，获取连接配置
  const [githubId] = token.split(':');
  if (!githubId) {
    return Response.json({ error: 'Invalid token format' }, { status: 400 });
  }
  const stub = getUserDBStub(env, githubId);
  const tokenRes = await stub.fetch(
    new Request('http://internal/internal/connect-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  );

  if (!tokenRes.ok) {
    return Response.json({ error: 'Invalid or expired connection token' }, { status: 403 });
  }

  const config = await tokenRes.json<SSHConnectionConfig>();
  if (!isGitHubUserAllowed(env, config.githubId ?? '')) {
    return Response.json({ error: 'GitHub account is not allowed' }, { status: 403 });
  }
  if (authenticatedUser && String(authenticatedUser.github_id) !== String(config.githubId)) {
    return Response.json(
      { error: 'Connection token does not belong to this GitHub account' },
      { status: 403 }
    );
  }

  const sessionName = `session:${Date.now()}:${Math.random()}`;
  const doId = env.SSH_SESSION.idFromName(sessionName);
  // Token 路径：locationHint 由 user-db.handleConnectServer 按最外层直连节点计算并写入 config
  // （优先级：入口服务器手动 region → 入口 DB 持久化 inferred_hint → undefined）
  // 这里仅做白名单过滤，连接阶段不会再次调用 IPinfo
  const hint = validateRegion(config.locationHint);
  const doStub = hint
    ? env.SSH_SESSION.get(doId, { locationHint: hint } as any)
    : env.SSH_SESSION.get(doId);

  const doUrl = parseRequestUrl(request.url);
  if (!doUrl) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  doUrl.searchParams.delete('token');
  doUrl.searchParams.set('session', sessionName);

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');
  headers.set('x-ssh-config', encodeURIComponent(JSON.stringify(config)));

  const doRequest = new Request(doUrl.toString(), {
    headers: headers,
  });

  return doStub.fetch(doRequest);
}

async function handleSFTPAttachConnection(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  const url = parseRequestUrl(request.url);
  if (!url) return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  if (!hasSameWebSocketOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  const sessionName = url.searchParams.get('session');
  const token = url.searchParams.get('token');
  if (!sessionName || !token) {
    return Response.json({ error: 'Missing SFTP attach token' }, { status: 403 });
  }

  const doId = env.SSH_SESSION.idFromName(sessionName);
  const stub = env.SSH_SESSION.get(doId);
  return stub.fetch(request);
}
