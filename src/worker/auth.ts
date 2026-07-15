import { Env, UserInfo } from '../types';

/**
 * GitHub OAuth 流程处理 + Session 中间件
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
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// ==================== 获取 UserDBDO stub ====================

function getUserDBStub(env: Env, githubId: string | number): DurableObjectStub {
  const id = env.USER_DB.idFromName(githubId.toString());
  return env.USER_DB.get(id);
}

// ==================== Session 中间件 ====================

/**
 * 验证请求中的 session cookie，返回用户信息或 null
 */
export async function getAuthenticatedUser(request: Request, env: Env): Promise<UserInfo | null> {
  const cookies = parseCookies(request);
  const sessionToken = cookies['session'];
  if (!sessionToken) return null;

  const [githubId] = sessionToken.split(':');
  if (!githubId) return null;

  const stub = getUserDBStub(env, githubId);
  const res = await stub.fetch(new Request('http://internal/internal/session/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: sessionToken }),
  }));

  if (!res.ok) return null;
  return res.json<UserInfo>();
}

// ==================== OAuth 路由处理 ====================

/**
 * GET /api/auth/github → 重定向到 GitHub 授权页
 */
export async function handleGitHubAuth(request: Request, env: Env): Promise<Response> {
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
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return Response.json({ error: 'GitHub OAuth not configured' }, { status: 501 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const baseUrl = getBaseUrl(env, request);

  // 1. 验证 state (防 CSRF)
  const cookies = parseCookies(request);
  if (!state || state !== cookies['oauth_state']) {
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

  // 4. 创建/更新用户
  const stub = getUserDBStub(env, githubUser.id);
  const userDbRes = await stub.fetch(new Request('http://internal/internal/oauth-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      github_id: githubUser.id,
      username: githubUser.login,
      avatar_url: githubUser.avatar_url,
    }),
  }));

  const user = await userDbRes.json<UserInfo>();

  // 5. 创建 session
  const sessionRes = await stub.fetch(new Request('http://internal/internal/session/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: user.id }),
  }));

  const sessionData = await sessionRes.json<{ token: string }>();

  // 6. Set-Cookie + 重定向到首页
  const responseHeaders = new Headers();
  responseHeaders.set('Location', baseUrl || '/');
  responseHeaders.append('Set-Cookie', `session=${sessionData.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
  responseHeaders.append('Set-Cookie', `oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);

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
  const sessionToken = cookies['session'];

  if (sessionToken) {
    const [githubId] = sessionToken.split(':');
    if (!githubId) {
      return Response.json({ success: true });
    }
    const stub = getUserDBStub(env, githubId);
    await stub.fetch(new Request('http://internal/internal/session/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken }),
    }));
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
