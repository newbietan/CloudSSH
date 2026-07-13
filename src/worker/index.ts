import { Env, SSHConnectionConfig, ALLOWED_LOCATION_HINTS } from '../types';
import { HTML } from './html';
import {
  handleGitHubAuth,
  handleGitHubCallback,
  handleLogout,
  handleGetMe,
  getAuthenticatedUser,
} from './auth';

export { SSHSessionDO } from './durable-object';
export { UserDBDO } from './user-db';

const RATE_LIMIT_MAX = 10;      // max requests per window
const RATE_LIMIT_WINDOW = 60000; // 1 minute window

// 分布式速率限制（使用 Durable Object）
async function isDistributedRateLimited(env: Env, ip: string): Promise<boolean> {
  try {
    const stub = getUserDBStub(env);
    const response = await stub.fetch(new Request('http://internal/internal/rate-limit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, maxRequests: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW }),
    }));

    if (!response.ok) return false;
    const result = await response.json<{ limited: boolean }>();
    return result.limited;
  } catch {
    return false;
  }
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
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload)
  );
  
  // 转换为十六进制字符串
  const signatureHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return `${payload}:${signatureHex}`;
}

async function isVerifiedTokenValid(token: string, secret: string): Promise<boolean> {
  try {
    const [expiresStr, signature] = token.split(':');
    const expires = parseInt(expiresStr);
    if (isNaN(expires) || Date.now() > expires) return false;
    
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
      signature.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
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
function getUserDBStub(env: Env): DurableObjectStub {
  const id = env.USER_DB.idFromName('global');
  return env.USER_DB.get(id);
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

    // ==================== Servers Routes (需认证) ====================

    if (url.pathname === '/api/servers' || url.pathname.startsWith('/api/servers/')) {
      return handleServersRoute(request, url, env);
    }

    // ==================== Theme Routes (需认证) ====================

    if (url.pathname === '/api/user/theme') {
      return handleThemeRoute(request, env);
    }

    // ==================== known_hosts Routes (需认证) ====================

    if (url.pathname === '/api/known-hosts' || url.pathname.startsWith('/api/known-hosts/')) {
      return handleKnownHostsRoute(request, url, env);
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
      // Apply rate limiting (distributed via Durable Object)
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (await isDistributedRateLimited(env, clientIP)) {
        return new Response('Too Many Requests', { status: 429 });
      }

      // Check for one-time-token (from server management connect)
      const connectToken = url.searchParams.get('token');
      if (connectToken) {
        return handleTokenSSHConnection(request, env, connectToken);
      }

      // Verify Turnstile if secret is configured
      if (env.TURNSTILE_SECRET) {
        // Check if user has a valid verification cookie
        const cookies = request.headers.get('Cookie') || '';
        const verifiedCookie = cookies.split(';').find(c => c.trim().startsWith('cf_verified='));
        const verifiedToken = verifiedCookie?.split('=')[1];

        if (!verifiedToken || !await isVerifiedTokenValid(verifiedToken, env.TURNSTILE_SECRET)) {
          // No valid cookie, check Turnstile token
          const turnstileToken = url.searchParams.get('turnstile_token');
          if (!turnstileToken) {
            return Response.json({ error: 'Missing Turnstile token' }, { status: 403 });
          }
          const isValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, clientIP);
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
        githubAuthEnabled: !!env.GITHUB_CLIENT_ID,
      });
    }

    return new Response(HTML, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
      }
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

  const stub = getUserDBStub(env);

  // GET /api/servers
  if (url.pathname === '/api/servers' && request.method === 'GET') {
    return stub.fetch(new Request(`http://internal/internal/servers?user_id=${user.id}`, {
      method: 'GET',
    }));
  }

  // POST /api/servers
  if (url.pathname === '/api/servers' && request.method === 'POST') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(new Request('http://internal/internal/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  // /api/servers/:id/connect
  const connectMatch = url.pathname.match(/^\/api\/servers\/(\d+)\/connect$/);
  if (connectMatch && request.method === 'POST') {
    const serverId = connectMatch[1];
    const tokenRes = await stub.fetch(new Request(`http://internal/internal/servers/${serverId}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id }),
    }));

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
      return stub.fetch(new Request(`http://internal/internal/servers/${serverId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
    }

    // DELETE /api/servers/:id
    if (request.method === 'DELETE') {
      return stub.fetch(new Request(`http://internal/internal/servers/${serverId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: user.id }),
      }));
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

  const stub = getUserDBStub(env);

  if (request.method === 'GET') {
    return stub.fetch(new Request(`http://internal/internal/theme?user_id=${user.id}`, {
      method: 'GET',
    }));
  }

  if (request.method === 'PUT') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    body.theme_data = JSON.stringify(body.theme_data);
    return stub.fetch(new Request('http://internal/internal/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ==================== known_hosts routes ====================

async function handleKnownHostsRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env);

  // GET /api/known-hosts?host=X&port=Y  → 获取特定主机指纹
  // GET /api/known-hosts                 → 列出所有已知主机
  if (request.method === 'GET') {
    const host = url.searchParams.get('host');
    const port = url.searchParams.get('port');
    const qs = new URLSearchParams({ user_id: String(user.id) });
    if (host) qs.set('host', host);
    if (port) qs.set('port', port);
    return stub.fetch(new Request(`http://internal/internal/known-hosts?${qs}`, {
      method: 'GET',
    }));
  }

  // POST /api/known-hosts  → 存储/更新主机指纹
  if (request.method === 'POST') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(new Request('http://internal/internal/known-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  // DELETE /api/known-hosts  → 删除主机指纹
  if (request.method === 'DELETE') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;
    return stub.fetch(new Request('http://internal/internal/known-hosts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}

// ==================== AI config routes ====================

async function handleAIRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const stub = getUserDBStub(env);

  // GET /api/ai/config — return current AI config (masked)
  if (url.pathname === '/api/ai/config' && request.method === 'GET') {
    return stub.fetch(new Request(`http://internal/internal/ai-config?user_id=${user.id}`, {
      method: 'GET',
    }));
  }

  // PUT /api/ai/config — save AI config
  if (url.pathname === '/api/ai/config' && request.method === 'PUT') {
    const body = await request.json<Record<string, unknown>>();
    body.user_id = user.id;

    // SSRF validation for base_url
    if (body.base_url) {
      const { validateBaseUrl } = await import('./agent/ssrf');
      const check = validateBaseUrl(body.base_url as string);
      if (!check.valid) {
        return Response.json({ error: check.reason }, { status: 400 });
      }
    }

    return stub.fetch(new Request('http://internal/internal/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  // POST /api/ai/models — proxy model list from user's LLM provider
  if (url.pathname === '/api/ai/models' && request.method === 'POST') {
    const { base_url, api_key } = await request.json<{ base_url: string; api_key: string }>();

    if (!base_url || !api_key) {
      return Response.json({ error: 'Missing base_url or api_key' }, { status: 400 });
    }

    // SSRF validation
    const { validateBaseUrl } = await import('./agent/ssrf');
    const check = validateBaseUrl(base_url);
    if (!check.valid) {
      return Response.json({ error: check.reason }, { status: 400 });
    }

    try {
      const modelsUrl = `${base_url.replace(/\/$/, '')}/models`;
      const res = await fetch(modelsUrl, {
        headers: {
          'Authorization': `Bearer ${api_key}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        if (res.status === 404) {
          return Response.json({ models: [], fallback: true, reason: 'Provider does not support /models endpoint' });
        }
        if (res.status === 401 || res.status === 403) {
          return Response.json({ error: 'API Key invalid or insufficient permissions' }, { status: res.status });
        }
        return Response.json({ error: `Provider returned ${res.status}` }, { status: 502 });
      }

      const data = await res.json() as any;
      const models: Array<{ id: string }> = (data.data || [])
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

async function handleSSHConnection(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json(
      { error: 'Expected WebSocket upgrade' },
      { status: 426 }
    );
  }

  const url = new URL(request.url);

  // Prevent Cross-Site WebSocket Hijacking / Quota Leeching
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin !== url.origin) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  const sessionName = `session:${Date.now()}:${Math.random()}`;
  const doId = env.SSH_SESSION.idFromName(sessionName);
  // 匿名路径不做自动推断（Worker 在 upgrade 时拿不到 host）；
  // 仅尊重用户通过前端下拉手动传入的 ?region= 覆盖值
  const region = validateRegion(url.searchParams.get('region'));
  const stub = region
    ? env.SSH_SESSION.get(doId, { locationHint: region } as any)
    : env.SSH_SESSION.get(doId);

  const doUrl = new URL(request.url);
  doUrl.searchParams.set('session', sessionName);

  const headers = new Headers(request.headers);
  headers.set('x-cloudflare-colo', (request as any).cf?.colo || 'UNKNOWN');

  return stub.fetch(new Request(doUrl.toString(), { headers }));
}

/**
 * 处理通过 one-time-token 发起的 SSH 连接
 * 流程：从 UserDBDO 消费 token 获取凭据 → 传给 SSHSessionDO
 */
async function handleTokenSSHConnection(request: Request, env: Env, token: string): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 });
  }

  // Prevent Cross-Site WebSocket Hijacking
  const origin = request.headers.get('Origin');
  if (origin) {
    const url = new URL(request.url);
    if (origin !== url.origin) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  // 从 UserDBDO 消费 token，获取连接配置
  const stub = getUserDBStub(env);
  const tokenRes = await stub.fetch(new Request('http://internal/internal/connect-token/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }));

  if (!tokenRes.ok) {
    return Response.json({ error: 'Invalid or expired connection token' }, { status: 403 });
  }

  const config = await tokenRes.json<SSHConnectionConfig>();

  const sessionName = `session:${Date.now()}:${Math.random()}`;
  const doId = env.SSH_SESSION.idFromName(sessionName);
  // Token 路径：locationHint 由 user-db.handleConnectServer 一次性计算并写入 config
  // （优先级：用户手动 region → DB 持久化的 inferred_hint → undefined）
  // 这里仅做白名单过滤，零运行时 ipapi 调用
  const hint = validateRegion(config.locationHint);
  const doStub = hint
    ? env.SSH_SESSION.get(doId, { locationHint: hint } as any)
    : env.SSH_SESSION.get(doId);

  const doUrl = new URL(request.url);
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

  const origin = request.headers.get('Origin');
  if (origin) {
    const url = new URL(request.url);
    if (origin !== url.origin) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  const url = new URL(request.url);
  const sessionName = url.searchParams.get('session');
  const token = url.searchParams.get('token');
  if (!sessionName || !token) {
    return Response.json({ error: 'Missing SFTP attach token' }, { status: 403 });
  }

  const doId = env.SSH_SESSION.idFromName(sessionName);
  const stub = env.SSH_SESSION.get(doId);
  return stub.fetch(request);
}
