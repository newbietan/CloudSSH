import type { Env, PasswordAuthParams, UserInfo } from '../types';

/**
 * GitHub OAuth 流程处理 + Session 中间件 + 单管理员密码认证
 */

// ==================== Cookie 工具 ====================

function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [key, ...vals] = part.trim().split('=');
    if (key) cookies[key.trim()] = vals.join('=').trim();
  }
  return cookies;
}

function getBaseUrl(env: Env, request: Request): string {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/$/, '');
  // request.url 由 Workers 运行时保证为合法绝对 URL；防御性兜底避免抛错。
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

// ==================== 获取 UserDBDO stub ====================

function getUserDBStub(env: Env, githubId: string | number): DurableObjectStub {
  const id = env.USER_DB.idFromName(githubId.toString());
  return env.USER_DB.get(id);
}

// ==================== 单管理员密码认证 ====================

/**
 * 本地管理员哨兵路由键。GitHub 用户 ID 恒为正整数，-1 无碰撞；
 * 全系统（会话/一次性令牌/分享 owner_github_id/AI 配置）都用它定位
 * 本地管理员的专属 UserDBDO 实例（idFromName('-1')）。
 */
const LOCAL_ADMIN_GITHUB_ID = -1;
export { LOCAL_ADMIN_GITHUB_ID };
const LOCAL_ADMIN_ROUTE_KEY = String(LOCAL_ADMIN_GITHUB_ID);

/** 会话令牌内嵌的密码代际指纹长度（sha256 前 8 hex）；换 ADMIN_PASSWORD_HASH 即吊销全部旧会话 */
const ADMIN_HASH_FINGERPRINT_LEN = 8;

export type AuthMode = 'password' | 'github' | 'anonymous';

/**
 * 认证模式解析（密码优先）：
 * - ADMIN_PASSWORD_HASH 非空 → 密码模式（GitHub 配置原地保留但路由禁用）
 * - 仅 GitHub ID+SECRET → GitHub 模式
 * - 都无 → 匿名模式（现状）
 * 哈希非空但格式损坏时仍返回 'password'：登录 fail closed，绝不静默回退。
 */
export function resolveAuthMode(env: Env): AuthMode {
  const hash = env.ADMIN_PASSWORD_HASH;
  if (hash !== undefined && hash.trim() !== '') return 'password';
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) return 'github';
  return 'anonymous';
}

export interface ParsedAdminHash {
  iterations: number;
  salt: Uint8Array;
  /** 32 字节：SHA-256(PBKDF2(password, salt, iterations))，与浏览器预拉伸后的密钥比对 */
  verifier: Uint8Array;
}

/**
 * 解析 ADMIN_PASSWORD_HASH（pbkdf2$sha256$<iterations>$<salt-b64url>$<verifier-b64url>）。
 * 返回 null = 未配置；'invalid' = 非空但格式损坏（fail closed 依据）；解析成功返回结构。
 */
export function parseAdminPasswordHash(raw: string | undefined): ParsedAdminHash | 'invalid' | null {
  if (raw === undefined || raw.trim() === '') return null;
  const match = /^pbkdf2\$sha256\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(raw.trim());
  if (!match) return 'invalid';

  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1000 || iterations > 10_000_000) {
    return 'invalid';
  }
  const salt = b64urlToBytes(match[2]);
  const verifier = b64urlToBytes(match[3]);
  if (!salt || salt.length < 8 || salt.length > 64) return 'invalid';
  if (!verifier || verifier.length !== 32) return 'invalid';
  return { iterations, salt, verifier };
}

/** 当前密码代际指纹（哈希串 SHA-256 前 8 hex）；未配置返回 null */
async function adminHashFingerprint(env: Env): Promise<string | null> {
  const raw = env.ADMIN_PASSWORD_HASH;
  if (!raw || raw.trim() === '') return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, ADMIN_HASH_FINGERPRINT_LEN);
}

/** /api/config 下发的浏览器预拉伸公开参数（盐非机密）；哈希无效/未配置返回 null */
export function getPasswordAuthParams(env: Env): PasswordAuthParams | null {
  const parsed = parseAdminPasswordHash(env.ADMIN_PASSWORD_HASH);
  if (parsed === null || parsed === 'invalid') return null;
  return { kdf: 'pbkdf2-sha256', iterations: parsed.iterations, salt: bytesToB64url(parsed.salt) };
}

function b64urlToBytes(input: string): Uint8Array | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    // 非法填充/字符：返回 null 由调用方按 fail-closed 处理，绝不让 atob 异常穿透
    return null;
  }
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 恒时字节比较（等长哈希比对；避免依赖 Workers 专属的 timingSafeEqual，可在 Node 测试环境运行） */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Turnstile 人机验证（index.ts 的 /api/verify 与本文件登录共用） */
export async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
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

interface GitHubAccessPolicy {
  restricted: boolean;
  valid: boolean;
  allowedIds: Set<string>;
}

/**
 * 解析可选 GitHub ID 白名单。
 * - 未配置：不限制 GitHub 用户。
 * - 已配置但为空：拒绝所有 GitHub 用户。
 * - 含非法值：配置无效并 fail closed，避免误开放实例。
 */
function getGitHubAccessPolicy(env: Env): GitHubAccessPolicy {
  const raw = env.GITHUB_ALLOWED_USER_IDS;
  if (raw === undefined) {
    return { restricted: false, valid: true, allowedIds: new Set() };
  }

  if (raw.trim() === '') {
    return { restricted: true, valid: true, allowedIds: new Set() };
  }

  const entries = raw.split(',').map((entry) => entry.trim());
  const allowedIds = new Set<string>();
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) {
      return { restricted: true, valid: false, allowedIds: new Set() };
    }
    allowedIds.add(entry);
  }

  return { restricted: true, valid: true, allowedIds };
}

export function isGitHubUserAllowed(env: Env, githubId: string | number): boolean {
  const policy = getGitHubAccessPolicy(env);
  if (!policy.valid) return false;
  return !policy.restricted || policy.allowedIds.has(String(githubId));
}

/**
 * 未配置、空字符串或 "false" 保持匿名模式；其他非空值均按开启处理
 *（fail closed），防止运维拼写错误意外重新开放匿名 SSH。
 */
export function isGitHubAuthRequired(env: Env): boolean {
  const raw = env.REQUIRE_GITHUB_AUTH;
  if (raw === undefined || raw.trim() === '') return false;
  return raw.trim().toLowerCase() !== 'false';
}

function oauthFailure(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Set-Cookie': 'oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

// ==================== Session 中间件 ====================

/**
 * 验证请求中的 session cookie，返回用户信息或 null。
 *
 * 认证模式门（双向）：
 * - 密码模式：仅本地管理员会话合法，且令牌内嵌的密码代际指纹必须与当前
 *   ADMIN_PASSWORD_HASH 一致（换哈希 → 旧会话即刻失效）；GitHub 会话一律拒绝。
 * - GitHub/匿名模式：拒绝哨兵（本地管理员）会话，防止移除哈希后旧管理员
 *   cookie 仍可认证。
 */
export async function getAuthenticatedUser(request: Request, env: Env): Promise<UserInfo | null> {
  const cookies = parseCookies(request);
  const sessionToken = cookies.session;
  if (!sessionToken) return null;

  const [routeKey] = sessionToken.split(':');
  if (!routeKey) return null;

  if (resolveAuthMode(env) === 'password') {
    if (routeKey !== LOCAL_ADMIN_ROUTE_KEY) return null;
    const parts = sessionToken.split(':');
    if (parts.length !== 3) return null;
    const fingerprint = await adminHashFingerprint(env);
    if (!fingerprint || parts[1] !== fingerprint) return null;
  } else if (routeKey === LOCAL_ADMIN_ROUTE_KEY) {
    return null;
  }

  const stub = getUserDBStub(env, routeKey);
  const res = await stub.fetch(
    new Request('http://internal/internal/session/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken }),
    })
  );

  if (!res.ok) return null;
  const user = await res.json<UserInfo>();
  // 本地管理员不适用 GitHub 白名单（该名单仅约束 GitHub 账号）
  if (user.github_id === LOCAL_ADMIN_GITHUB_ID) return user;
  return isGitHubUserAllowed(env, user.github_id) ? user : null;
}

// ==================== OAuth 路由处理 ====================

/**
 * GET /api/auth/github → 重定向到 GitHub 授权页
 */
export async function handleGitHubAuth(request: Request, env: Env): Promise<Response> {
  if (resolveAuthMode(env) === 'password') {
    // 密码模式权威闸门：前端入口已替换为管理员登录，此处兜住直接 URL/旧标签页
    return Response.json(
      { error: 'Password auth mode is active; remove ADMIN_PASSWORD_HASH to re-enable GitHub login' },
      { status: 501 }
    );
  }
  if (!env.GITHUB_CLIENT_ID) {
    return Response.json({ error: 'GitHub OAuth not configured' }, { status: 501 });
  }

  const state = crypto.randomUUID();
  const baseUrl = getBaseUrl(env, request);

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${baseUrl}/api/auth/callback`,
    scope: 'read:user',
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/**
 * GET /api/auth/callback → OAuth 回调
 * 验证 state → 用 code 换 token → 获取用户信息 → 创建 session → Set-Cookie → 302
 */
export async function handleGitHubCallback(request: Request, env: Env): Promise<Response> {
  // 密码模式下堵死唯一的建用户入口（OAuth 回调 upsert），保持单管理员排他性
  if (resolveAuthMode(env) === 'password') {
    return Response.json(
      { error: 'Password auth mode is active; remove ADMIN_PASSWORD_HASH to re-enable GitHub login' },
      { status: 501 }
    );
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return Response.json({ error: 'GitHub OAuth not configured' }, { status: 501 });
  }

  // request.url 由 Workers 运行时保证为合法绝对 URL；防御性兜底避免抛出。
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Invalid callback URL', { status: 400 });
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const baseUrl = getBaseUrl(env, request);

  // 1. 验证 state (防 CSRF)
  const cookies = parseCookies(request);
  if (!state || state !== cookies.oauth_state) {
    return new Response('Invalid state parameter (CSRF protection)', { status: 403 });
  }

  if (!code) {
    return new Response('Missing authorization code', { status: 400 });
  }

  // 2. 用 code 换 access_token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${baseUrl}/api/auth/callback`,
    }),
  });

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    return new Response(`GitHub OAuth error: ${tokenData.error || 'unknown'}`, { status: 400 });
  }

  // 3. 获取 GitHub 用户信息
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'CloudSSH',
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!userRes.ok) {
    return new Response('Failed to fetch GitHub user info', { status: 500 });
  }

  const githubUser = await userRes.json<{
    id: number;
    login: string;
    avatar_url: string;
  }>();

  const accessPolicy = getGitHubAccessPolicy(env);
  if (!accessPolicy.valid) {
    return oauthFailure('GitHub access allowlist is invalid', 503);
  }
  if (accessPolicy.restricted && !accessPolicy.allowedIds.has(String(githubUser.id))) {
    return oauthFailure('This GitHub account is not allowed to access CloudSSH', 403);
  }

  // 4. 创建/更新用户
  const stub = getUserDBStub(env, githubUser.id);
  const userDbRes = await stub.fetch(
    new Request('http://internal/internal/oauth-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        github_id: githubUser.id,
        username: githubUser.login,
        avatar_url: githubUser.avatar_url,
      }),
    })
  );

  const user = await userDbRes.json<UserInfo>();

  // 5. 创建 session
  const sessionRes = await stub.fetch(
    new Request('http://internal/internal/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id }),
    })
  );

  const sessionData = await sessionRes.json<{ token: string }>();

  // 6. Set-Cookie + 重定向到首页
  const responseHeaders = new Headers();
  responseHeaders.set('Location', baseUrl || '/');
  responseHeaders.append(
    'Set-Cookie',
    `session=${sessionData.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
  );
  responseHeaders.append(
    'Set-Cookie',
    `oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );

  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

/**
 * POST /api/auth/logout → 登出
 */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(request);
  const sessionToken = cookies.session;

  if (sessionToken) {
    const [githubId] = sessionToken.split(':');
    if (!githubId) {
      return Response.json({ success: true });
    }
    const stub = getUserDBStub(env, githubId);
    await stub.fetch(
      new Request('http://internal/internal/session/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sessionToken }),
      })
    );
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}

/**
 * GET /api/auth/me → 获取当前用户信息
 */
export async function handleGetMe(request: Request, env: Env): Promise<Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  return Response.json(user);
}

// ==================== 单管理员密码登录 ====================

/**
 * POST /api/auth/password/login → 单管理员密码登录。
 *
 * 浏览器先按 /api/config 下发的公开参数（盐/迭代数）在本地完成 PBKDF2 预拉伸
 * （server relief，规避 Free 套餐 10ms CPU 上限），提交 32 字节拉伸密钥；
 * 本端仅做一次 SHA-256 + 恒时比对。防线：同源 Origin 校验 → Turnstile（已配置
 * 时）→ 哨兵 DO 持久化节流（跨 isolate，指数退避封顶 15 分钟）→ 恒时比对。
 */
export async function handlePasswordLogin(request: Request, env: Env): Promise<Response> {
  const parsedHash = parseAdminPasswordHash(env.ADMIN_PASSWORD_HASH);
  if (parsedHash === null) {
    return Response.json({ error: 'Password auth not enabled' }, { status: 501 });
  }
  if (parsedHash === 'invalid') {
    // 坏哈希 fail closed：绝不静默回退到 GitHub/匿名模式
    console.error('[Auth] ADMIN_PASSWORD_HASH is non-empty but malformed; login fails closed');
    return Response.json({ error: 'Admin password hash is invalid' }, { status: 500 });
  }

  // 同源 Origin 校验（登录会种会话 cookie，防跨站登录 CSRF；与 WS origin 边界同哲学）
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return Response.json({ error: 'Invalid request URL' }, { status: 400 });
  }
  const origin = request.headers.get('Origin');
  if (!origin || origin !== `${url.protocol}//${url.host}`) {
    return Response.json({ error: 'Forbidden origin' }, { status: 403 });
  }

  let body: { key?: unknown; turnstileToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  // 32 字节 base64url = 43 字符；容忍少量余量防填充差异
  const key = typeof body.key === 'string' ? body.key : '';
  if (!/^[A-Za-z0-9_-]{43,64}$/.test(key)) {
    return Response.json({ error: 'Invalid key format' }, { status: 400 });
  }

  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const stub = getUserDBStub(env, LOCAL_ADMIN_GITHUB_ID);

  // Turnstile（已配置则必验；公网部署建议开启以阻断自动化爆破）
  if (env.TURNSTILE_SECRET) {
    const turnstileToken = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
    if (!turnstileToken) {
      return Response.json({ error: 'Turnstile verification required' }, { status: 403 });
    }
    const valid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, clientIP);
    if (!valid) {
      console.warn(`[Auth] password_login result=denied reason=turnstile ip=${clientIP}`);
      return Response.json({ error: 'Turnstile verification failed' }, { status: 403 });
    }
  }

  // 登录节流（哨兵 DO 持久化，跨 isolate 权威；命中锁定直接拒绝，不泄露更多信息）
  const throttleRes = await stub.fetch(
    new Request('http://internal/internal/login-throttle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    })
  );
  if (!throttleRes.ok) {
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
  const throttle = await throttleRes.json<{ locked: boolean; retryAfterSec: number }>();
  if (throttle.locked) {
    console.warn(`[Auth] password_login result=denied reason=lockout ip=${clientIP}`);
    return Response.json(
      { error: 'Too many failed attempts', retryAfterSec: throttle.retryAfterSec },
      { status: 429 }
    );
  }

  // 验证预拉伸密钥：SHA-256(key) 恒时比对 verifier
  const keyBytes = b64urlToBytes(key);
  if (!keyBytes || keyBytes.length !== 32) {
    return Response.json({ error: 'Invalid key format' }, { status: 400 });
  }
  const keyDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes));
  if (!timingSafeEqualBytes(keyDigest, parsedHash.verifier)) {
    await stub.fetch(
      new Request('http://internal/internal/login-throttle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fail' }),
      })
    );
    console.warn(`[Auth] password_login result=denied reason=bad_key ip=${clientIP}`);
    return Response.json({ error: 'Invalid password' }, { status: 401 });
  }

  // 登录成功：重置节流 → upsert 本地管理员 → 创建会话
  await stub.fetch(
    new Request('http://internal/internal/login-throttle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    })
  );

  const userRes = await stub.fetch(
    new Request('http://internal/internal/local-admin-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  );
  if (!userRes.ok) {
    return Response.json({ error: 'Failed to provision admin account' }, { status: 500 });
  }
  const user = await userRes.json<UserInfo>();

  // 会话令牌内嵌密码代际指纹：-1:<fp8>:<randomHex>；换 ADMIN_PASSWORD_HASH 即全灭旧会话
  const fingerprint = await adminHashFingerprint(env);
  if (!fingerprint) {
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
  const token = `${LOCAL_ADMIN_GITHUB_ID}:${fingerprint}:${randomHex(32)}`;
  const sessionRes = await stub.fetch(
    new Request('http://internal/internal/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id, token }),
    })
  );
  if (!sessionRes.ok) {
    return Response.json({ error: 'Failed to create session' }, { status: 500 });
  }

  console.log(`[Auth] password_login result=ok ip=${clientIP}`);
  return new Response(JSON.stringify(user), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    },
  });
}
