import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';

// =====================================================================
// security.test.ts
// ---------------------------------------------------------------
// CloudSSH worker 外层接缝的安全回归测试。聚焦"关键安全领域"，
// 不追求全分支覆盖——有状态组件走人工测试。
//
// 用例覆盖六类高危漏洞/访问控制边界：
//   1. CSRF        — OAuth 回调 state 校验
//   2. GitHub 策略 — 登录白名单、强制登录及 token 归属
//   3. IDOR/越权   — handler 强制覆盖 body.user_id、DO 层二次归属校验
//   4. SSRF 接缝   — AI base_url 经 validateBaseUrl 在路由层拦截
//   5. 签名伪造    — cf_verified cookie HMAC 完整性
//   6. CSWSH       — 跨站 WebSocket 劫持（Origin 校验）
//   附：一次性 token 防重放、SFTP attach 鉴权、速率限制
//
// 全部走 default export 的 fetch 入口，不导出内部函数，最接近真实
// 攻击路径。DO stub 与 global.fetch 用 vi.fn() mock。
// =====================================================================

// 动态 import worker default，避免在 mock 设置前触发模块顶层副作用
async function loadWorker() {
  const mod = await import('../../src/worker/index');
  return mod.default;
}

// ---------- mock helpers ----------

/** 伪造一个 DurableObjectStub：fetch 返回预设 Response */
function makeDOStub(responder: (req: Request) => Response | Promise<Response>) {
  return {
    fetch: vi.fn((req: Request) => responder(req)),
  };
}

/** 构造一个 env，USER_DB / SSH_SESSION 的 stub 可自定义 */
function makeEnv(
  overrides: Partial<Env> & { userDbStub?: any; sshSessionStub?: any; sshShareStub?: any } = {}
): Env {
  const { userDbStub, sshSessionStub, sshShareStub, ...rest } = overrides;
  const defaultStub = makeDOStub(() => new Response('{"error":"not mocked"}', { status: 500 }));
  return {
    SSH_SESSION: { idFromName: () => 'do-ssh', get: () => sshSessionStub ?? defaultStub } as any,
    USER_DB: { idFromName: () => 'do-userdb', get: () => userDbStub ?? defaultStub } as any,
    SSH_SHARE: { idFromName: () => 'do-share', get: () => sshShareStub ?? defaultStub } as any,
    ...rest,
  } as Env;
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    cookies?: Record<string, string>;
  } = {}
): Request {
  const url = new URL(`https://cloudssh.test${path}`);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookies) {
    headers['Cookie'] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  return new Request(url.toString(), init);
}

// ---------- 集中 mock global.fetch（OAuth / Turnstile / LLM 代理都用它） ----------

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => {
  (globalThis as any).fetch = undefined as any;
});

// =====================================================================
// 1. auth.ts — OAuth 回调 CSRF 防护
// =====================================================================

describe('安全 — OAuth 回调 CSRF 防护', () => {
  it('state 与 cookie 中 oauth_state 不匹配 → 403', async () => {
    // 攻击者诱导用户点击构造链接：query.state=attacker_state，但用户浏览器里 cookie 是合法 state
    const worker = await loadWorker();
    const env = makeEnv({
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
    });
    const req = makeRequest('/api/auth/callback?code=legit_code&state=attacker_state', {
      cookies: { oauth_state: 'legit_state' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/state/i);
    // 攻击码不应到达 GitHub token 兑换
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('state 正确但 code 缺失 → 400，不调用 GitHub API', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
    });
    const req = makeRequest('/api/auth/callback?state=legit_state', {
      cookies: { oauth_state: 'legit_state' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('未认证访问 /api/auth/me → 401', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      userDbStub: makeDOStub(() => new Response('{"error":"invalid"}', { status: 401 })),
    });
    const req = makeRequest('/api/auth/me', { cookies: { session: 'fake_session_token' } });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(401);
  });
});

// =====================================================================
// 2. GitHub 访问策略（OAuth 白名单 + 强制登录）
// =====================================================================

describe('安全 — GitHub 用户白名单', () => {
  function mockOAuthUser(githubId: number, login = 'alice') {
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: 'oauth-token' }))
      .mockResolvedValueOnce(
        Response.json({
          id: githubId,
          login,
          avatar_url: 'https://avatars.example/alice.png',
        })
      );
  }

  function makeOAuthUserDbStub(githubId: number) {
    return makeDOStub(async (request) => {
      if (request.url.includes('/internal/oauth-user')) {
        return Response.json({ id: 12, github_id: githubId, username: 'alice', avatar_url: '' });
      }
      if (request.url.includes('/internal/session/create')) {
        return Response.json({ token: `${githubId}:session-token` });
      }
      return Response.json({ error: 'not mocked' }, { status: 500 });
    });
  }

  it.each([
    ['未配置白名单', undefined],
    ['GitHub ID 在白名单中', '42, 100'],
  ])('%s时允许 OAuth 登录', async (_name, allowedIds) => {
    const worker = await loadWorker();
    const userDbStub = makeOAuthUserDbStub(42);
    const env = makeEnv({
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
      GITHUB_ALLOWED_USER_IDS: allowedIds,
      userDbStub,
    });
    mockOAuthUser(42);

    const res = await worker.fetch(
      makeRequest('/api/auth/callback?code=code&state=state', {
        cookies: { oauth_state: 'state' },
      }),
      env
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('session=42:session-token');
    expect(userDbStub.fetch).toHaveBeenCalledTimes(2);
  });

  it('GitHub ID 不在白名单中时拒绝登录且不写入用户数据', async () => {
    const worker = await loadWorker();
    const userDbStub = makeOAuthUserDbStub(42);
    const env = makeEnv({
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
      GITHUB_ALLOWED_USER_IDS: '7,8',
      userDbStub,
    });
    mockOAuthUser(42);

    const res = await worker.fetch(
      makeRequest('/api/auth/callback?code=code&state=state', {
        cookies: { oauth_state: 'state' },
      }),
      env
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/not allowed/i);
    expect(res.headers.get('set-cookie')).toContain('oauth_state=;');
    expect(userDbStub.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['空白名单', ''],
    ['包含非法值', '42,alice'],
  ])('%s采用 fail-closed', async (_name, allowedIds) => {
    const worker = await loadWorker();
    const userDbStub = makeOAuthUserDbStub(42);
    const env = makeEnv({
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
      GITHUB_ALLOWED_USER_IDS: allowedIds,
      userDbStub,
    });
    mockOAuthUser(42);

    const res = await worker.fetch(
      makeRequest('/api/auth/callback?code=code&state=state', {
        cookies: { oauth_state: 'state' },
      }),
      env
    );

    expect([403, 503]).toContain(res.status);
    expect(userDbStub.fetch).not.toHaveBeenCalled();
  });

  it('白名单变更后既有 session 立即失效', async () => {
    const worker = await loadWorker();
    const userDbStub = makeDOStub(() =>
      Response.json({
        id: 12,
        github_id: 42,
        username: 'alice',
        avatar_url: '',
      })
    );
    const makeSessionRequest = () =>
      makeRequest('/api/auth/me', {
        cookies: { session: '42:existing-session' },
      });

    const allowed = await worker.fetch(
      makeSessionRequest(),
      makeEnv({
        GITHUB_ALLOWED_USER_IDS: '42',
        userDbStub,
      })
    );
    expect(allowed.status).toBe(200);

    const denied = await worker.fetch(
      makeSessionRequest(),
      makeEnv({
        GITHUB_ALLOWED_USER_IDS: '7',
        userDbStub,
      })
    );
    expect(denied.status).toBe(401);
  });
});

describe('安全 — 强制 GitHub 登录模式', () => {
  it.each([
    [undefined, false],
    ['false', false],
    ['true', true],
    ['ture', true],
  ])('REQUIRE_GITHUB_AUTH=%s 时 /api/config 返回 %s', async (value, expected) => {
    const worker = await loadWorker();
    const res = await worker.fetch(
      makeRequest('/api/config'),
      makeEnv({
        REQUIRE_GITHUB_AUTH: value,
      })
    );
    expect(
      ((await res.json()) as { githubAuthRequired?: boolean }).githubAuthRequired
    ).toBe(expected);
  });

  it('强制登录时拒绝匿名 SSH WebSocket', async () => {
    const worker = await loadWorker();
    const sshSessionStub = makeDOStub(() => new Response('forwarded'));
    const env = makeEnv({ REQUIRE_GITHUB_AUTH: 'true', sshSessionStub });
    const req = makeRequest('/api/ssh', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(401);
    expect(sshSessionStub.fetch).not.toHaveBeenCalled();
  });

  it('强制登录时允许白名单内的有效 session 建立 SSH WebSocket', async () => {
    const worker = await loadWorker();
    const userDbStub = makeDOStub(() =>
      Response.json({
        id: 12,
        github_id: 42,
        username: 'alice',
        avatar_url: '',
      })
    );
    const sshSessionStub = makeDOStub(() => new Response('forwarded'));
    const env = makeEnv({
      REQUIRE_GITHUB_AUTH: 'true',
      GITHUB_ALLOWED_USER_IDS: '42',
      userDbStub,
      sshSessionStub,
    });
    const req = makeRequest('/api/ssh', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      cookies: { session: '42:session-token' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(sshSessionStub.fetch).toHaveBeenCalledOnce();
  });

  it('未开启强制登录时保持匿名 SSH 可用', async () => {
    const worker = await loadWorker();
    const sshSessionStub = makeDOStub(() => new Response('forwarded'));
    const env = makeEnv({ sshSessionStub });
    const req = makeRequest('/api/ssh', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(sshSessionStub.fetch).toHaveBeenCalledOnce();
  });
});

// =====================================================================
// 3. index.ts — IDOR / 越权防护（handler 覆盖 body.user_id + DO 二次校验）
// =====================================================================

describe('安全 — 越权防护（IDOR）', () => {
  it('POST /api/servers 时 body 注入 user_id=999 应被 handler 覆盖为真实 user.id', async () => {
    const worker = await loadWorker();
    // 用户真实 id=1，攻击者在 body 里塞 user_id=999 想把服务器存到别人名下
    let capturedBody: any;
    const env = makeEnv({
      userDbStub: makeDOStub(async (req) => {
        if (req.url.includes('/internal/session/verify')) {
          return new Response(
            JSON.stringify({ id: 1, github_id: 1, username: 'alice', avatar_url: '' }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        if (req.url.endsWith('/internal/servers') && req.method === 'POST') {
          capturedBody = await req.json();
          return new Response(JSON.stringify({ id: 1, user_id: 1 }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 500 });
      }),
    });

    const req = makeRequest('/api/servers', {
      method: 'POST',
      cookies: { session: 'legit_session' },
      body: { name: 'evil-server', user_id: 999, host: '1.2.3.4' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    // 关键断言：落到 DO 的 user_id 必须是 session 真实用户 1，而非 body 注入的 999
    expect(capturedBody.user_id).toBe(1);
    expect(capturedBody.user_id).not.toBe(999);
  });

  it('PUT /api/servers/:id 越权改他人服务器 → DO 层归属校验拒绝（返回 403）', async () => {
    const worker = await loadWorker();
    // 模拟 user-db.ts:357-359 的归属校验逻辑：服务器属于别人 → 返回 403
    const env = makeEnv({
      userDbStub: makeDOStub(async (req) => {
        if (req.url.includes('/internal/session/verify')) {
          return new Response(
            JSON.stringify({ id: 1, github_id: 1, username: 'alice', avatar_url: '' }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        // DO 收到 PUT /internal/servers/:id，检查 belong，属于他人 → 403
        if (req.url.match(/\/internal\/servers\/\d+$/) && req.method === 'PUT') {
          // 模拟：服务器 record.user_id=2 !== body.user_id=1
          return new Response(JSON.stringify({ error: 'Server does not belong to user' }), {
            status: 403,
          });
        }
        return new Response('{}', { status: 500 });
      }),
    });

    const req = makeRequest('/api/servers/42', {
      method: 'PUT',
      cookies: { session: 'legit_session' },
      body: { name: 'hijacked', user_id: 999 },
    });

    const res = await worker.fetch(req, env);

    // handler 用 user.id=1 覆盖 body.user_id，传给 DO；DO 归属校验失败返回 403
    expect(res.status).toBe(403);
  });
});

describe('安全 — 自定义主题接口边界', () => {
  function makeAuthenticatedThemeEnv(
    onThemeRequest: (request: Request) => Response | Promise<Response> = () =>
      Response.json({ success: true })
  ): Env {
    return makeEnv({
      userDbStub: makeDOStub((request) => {
        if (request.url.includes('/internal/session/verify')) {
          return Response.json({ id: 12, github_id: 987, username: 'alice', avatar_url: '' });
        }
        if (request.url.includes('/internal/theme')) return onThemeRequest(request);
        return Response.json({ error: 'not mocked' }, { status: 500 });
      }),
    });
  }

  it('未登录请求主题接口 → 401', async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(makeRequest('/api/user/theme'), makeEnv());

    expect(res.status).toBe(401);
  });

  it('读取主题时只使用认证用户 ID', async () => {
    const worker = await loadWorker();
    let forwardedUrl = '';
    const env = makeAuthenticatedThemeEnv((request) => {
      forwardedUrl = request.url;
      return Response.json({ theme: null });
    });
    const res = await worker.fetch(
      makeRequest('/api/user/theme', {
        cookies: { session: '987:legit_session' },
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(forwardedUrl).toContain('/internal/theme?user_id=12');
  });

  it('不受支持的方法 → 405', async () => {
    const worker = await loadWorker();
    const env = makeAuthenticatedThemeEnv();
    const res = await worker.fetch(
      makeRequest('/api/user/theme', {
        method: 'POST',
        cookies: { session: '987:legit_session' },
        body: {},
      }),
      env
    );

    expect(res.status).toBe(405);
  });

  it('无法解析的 JSON 请求体 → 400', async () => {
    const worker = await loadWorker();
    const onThemeRequest = vi.fn(() => Response.json({ success: true }));
    const env = makeAuthenticatedThemeEnv(onThemeRequest);
    const res = await worker.fetch(
      makeRequest('/api/user/theme', {
        method: 'PUT',
        cookies: { session: '987:legit_session' },
        body: '{"theme_data":',
      }),
      env
    );

    expect(res.status).toBe(400);
    expect(onThemeRequest).not.toHaveBeenCalled();
  });

  it('无有效主题字段或非法颜色 → 400 且不写入', async () => {
    const worker = await loadWorker();
    const onThemeRequest = vi.fn(() => Response.json({ success: true }));
    const env = makeAuthenticatedThemeEnv(onThemeRequest);
    const res = await worker.fetch(
      makeRequest('/api/user/theme', {
        method: 'PUT',
        cookies: { session: '987:legit_session' },
        body: {
          theme_data: {
            ui: {
              '--unknown': '#ffffff',
              '--bg': 'url(https://example.com/tracker.png)',
            },
          },
        },
      }),
      env
    );

    expect(res.status).toBe(400);
    expect(onThemeRequest).not.toHaveBeenCalled();
  });

  it('超过 64 KiB 的主题请求 → 413 且不写入', async () => {
    const worker = await loadWorker();
    const onThemeRequest = vi.fn(() => Response.json({ success: true }));
    const env = makeAuthenticatedThemeEnv(onThemeRequest);
    const res = await worker.fetch(
      makeRequest('/api/user/theme', {
        method: 'PUT',
        cookies: { session: '987:legit_session' },
        body: {
          theme_data: {
            name: 'x'.repeat(70 * 1024),
            ui: { '--accent': '#abcdef' },
          },
        },
      }),
      env
    );

    expect(res.status).toBe(413);
    expect(onThemeRequest).not.toHaveBeenCalled();
  });

  it('合法主题会规范化后使用认证用户 ID 写入自己的分片', async () => {
    const worker = await loadWorker();
    let forwardedBody: { user_id: number; theme_data: string } | undefined;
    const env = makeAuthenticatedThemeEnv(async (request) => {
      forwardedBody = await request.json();
      return Response.json({ success: true });
    });
    const res = await worker.fetch(
      makeRequest('/api/user/theme', {
        method: 'PUT',
        cookies: { session: '987:legit_session' },
        body: {
          theme_data: {
            schemaVersion: 999,
            name: '  Shared Theme  ',
            user_id: 999,
            ui: {
              '--accent': '#abcdef',
              '--unknown': '#ffffff',
            },
            appearance: {
              style: 'soft',
              motion: 'invalid',
            },
          },
        },
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(forwardedBody?.user_id).toBe(12);
    expect(JSON.parse(forwardedBody?.theme_data ?? '{}')).toEqual({
      schemaVersion: 3,
      name: 'Shared Theme',
      colorScheme: 'dark',
      ui: { '--accent': '#abcdef' },
      appearance: { style: 'soft' },
    });
  });
});

// =====================================================================
// 4. SSRF 接缝 — AI base_url 在路由层经 validateBaseUrl 拦截
// =====================================================================

describe('安全 — SSRF 接缝（AI base_url）', () => {
  it('PUT /api/ai/config base_url=内网地址 → 400', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      userDbStub: makeDOStub(async (req) => {
        if (req.url.includes('/internal/session/verify')) {
          return new Response(
            JSON.stringify({ id: 1, github_id: 1, username: 'alice', avatar_url: '' }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        return new Response('{}', { status: 500 });
      }),
    });

    const req = makeRequest('/api/ai/config', {
      method: 'PUT',
      cookies: { session: 'legit_session' },
      body: { base_url: 'http://192.168.1.1/v1', model: 'gpt-4' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect((data as { error?: string }).error).toBeTruthy(); // validateBaseUrl 返回的中文 reason
    // 不应到达 DO 持久化
    expect(env.USER_DB.get({} as any).fetch).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('/internal/ai-config') })
    );
  });

  it('POST /api/ai/models 拒绝 Provider 重定向', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      userDbStub: makeDOStub((req) => {
        if (req.url.includes('/internal/session/verify')) {
          return new Response(
            JSON.stringify({ id: 1, github_id: 42, username: 'alice', avatar_url: '' }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        return new Response('{}', { status: 500 });
      }),
    });
    // DoH responses for validateBaseUrlWithDNS (api.example.com → public IP)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Answer: [{ type: 1, data: '93.184.216.34' }] }), {
        headers: { 'Content-Type': 'application/dns-json' },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Answer: [] }), {
        headers: { 'Content-Type': 'application/dns-json' },
      })
    );
    // Models endpoint returns redirect (should be blocked by redirect: 'manual')
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/models' },
      })
    );

    const req = makeRequest('/api/ai/models', {
      method: 'POST',
      cookies: { session: '42:legit_session' },
      body: { base_url: 'https://api.example.com/v1', api_key: 'test-key' },
    });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({ redirect: 'manual' })
    );
  });
});

// =====================================================================
// 5. 签名伪造 — cf_verified cookie HMAC 完整性
// =====================================================================

describe('安全 — cf_verified 签名伪造', () => {
  it('伪造的 cf_verified cookie（签名不匹配）→ 走 Turnstile 分支且 token 无效 → 403', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      TURNSTILE_SECRET: 'supersecret',
    });

    // 伪造的 cookie：expires 远未来但签名是乱填的
    const fakeToken = '9999999999999:deadbeef';
    const req = makeRequest('/api/ssh?turnstile_token=bogus', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://cloudssh.test',
      },
      cookies: { cf_verified: fakeToken },
    });

    // Turnstile siteverify 失败
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await worker.fetch(req, env);

    // 伪造 cookie 通过不了 HMAC 校验 → 走 turnstile_token 分支 → turnstile 无效 → 403
    expect(res.status).toBe(403);
  });

  it('篡改签名（expires 不变，签名换 1 字节）→ HMAC verify 失败', async () => {
    const worker = await loadWorker();
    const env = makeEnv({ TURNSTILE_SECRET: 'supersecret' });

    // 先生成合法 token：手工走 generateVerifiedToken 的逻辑
    const secret = 'supersecret';
    const expires = String(Date.now() + 3600000); // 1h valid
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expires));
    const sigHex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    // 根据原字符选择必然不同的十六进制字符，确保每次都真正破坏签名。
    const tamperedSig = (sigHex[0] === '0' ? '1' : '0') + sigHex.slice(1);
    expect(tamperedSig).not.toBe(sigHex);
    const tamperedToken = `${expires}:${tamperedSig}`;

    // 需要直接调内部函数测——通过路由间接测：
    // 用篡改的 cookie 访问 /api/ssh，HMAC 应失败，走 turnstile 分支
    const req = makeRequest('/api/ssh?turnstile_token=bogus', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      cookies: { cf_verified: tamperedToken },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403); // 篡改签名 → 走 turnstile → turnstile 无效 → 403
  });

  it.each([
    [
      '签名长度错误',
      (expires: string, signature: string) => `${expires}:${signature.slice(0, -2)}`,
    ],
    [
      '签名包含非十六进制字符',
      (expires: string, signature: string) => `${expires}:z${signature.slice(1)}`,
    ],
    ['缺少分隔符', (expires: string, signature: string) => `${expires}${signature}`],
  ])('%s → 安全降级到 Turnstile 验证并返回 403', async (_name, makeToken) => {
    const worker = await loadWorker();
    const env = makeEnv({ TURNSTILE_SECRET: 'supersecret' });
    const expires = String(Date.now() + 3600000);
    const validLengthSignature = 'a'.repeat(64);
    const malformedToken = makeToken(expires, validLengthSignature);

    const req = makeRequest('/api/ssh?turnstile_token=bogus', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      cookies: { cf_verified: malformedToken },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// 6. CSWSH — 跨站 WebSocket 劫持（Origin 校验）
// =====================================================================

describe('安全 — 跨站 WebSocket 劫持（CSWSH）', () => {
  it('/api/ssh 跨域 Origin → 403 Forbidden', async () => {
    const worker = await loadWorker();
    const env = makeEnv(); // 未配置 TURNSTILE_SECRET，跳过验证分支，专注 Origin 校验

    const req = makeRequest('/api/ssh', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://evil.attacker.com',
      },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
  });

  it.each([
    ['匿名 SSH', '/api/ssh'],
    ['一次性 token SSH', '/api/ssh?token=987:one-time-token'],
    ['SFTP attach', '/api/ssh/sftp?session=session-1&token=attach-token'],
  ])('%s 缺少 Origin → 403 Forbidden', async (_name, path) => {
    const worker = await loadWorker();
    const env = makeEnv();
    const req = makeRequest(path, {
      headers: { Upgrade: 'websocket' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
  });
});

// =====================================================================
// 附：一次性 token 防重放 / SFTP attach 鉴权 / 速率限制
// =====================================================================

describe('安全 — 一次性 token 与接缝鉴权', () => {
  it('connect token 使用 githubId 前缀定位 UserDBDO 分片', async () => {
    const worker = await loadWorker();
    const idFromName = vi.fn(() => 'do-userdb');
    const userDbStub = makeDOStub(() =>
      Response.json({
        host: 'ssh.example.com',
        port: 22,
        username: 'alice',
        password: 'secret',
        userId: '12',
        githubId: '987',
      })
    );
    let forwardedConfig: any;
    const sshSessionStub = makeDOStub((req) => {
      const header = req.headers.get('x-ssh-config');
      forwardedConfig = header ? JSON.parse(decodeURIComponent(header)) : null;
      return new Response('forwarded');
    });
    const env = makeEnv({ sshSessionStub });
    env.USER_DB = { idFromName, get: () => userDbStub } as any;

    const req = makeRequest('/api/ssh?token=987:one-time-token', {
      headers: {
        'CF-Connecting-IP': '203.0.113.20',
        Upgrade: 'websocket',
        Origin: 'https://cloudssh.test',
      },
    });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('987');
    expect(forwardedConfig).toEqual(
      expect.objectContaining({
        userId: '12',
        githubId: '987',
      })
    );
  });

  it('白名单变更后拒绝尚未消费的一次性连接 token', async () => {
    const worker = await loadWorker();
    const userDbStub = makeDOStub(() =>
      Response.json({
        host: 'ssh.example.com',
        port: 22,
        username: 'alice',
        password: 'secret',
        userId: '12',
        githubId: '987',
      })
    );
    const sshSessionStub = makeDOStub(() => new Response('forwarded'));
    const env = makeEnv({
      GITHUB_ALLOWED_USER_IDS: '42',
      userDbStub,
      sshSessionStub,
    });
    const req = makeRequest('/api/ssh?token=987:one-time-token', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    expect(sshSessionStub.fetch).not.toHaveBeenCalled();
  });

  it('强制登录时一次性连接 token 仍要求有效 session', async () => {
    const worker = await loadWorker();
    const userDbStub = makeDOStub(() =>
      Response.json({ error: 'not authenticated' }, { status: 401 })
    );
    const env = makeEnv({ REQUIRE_GITHUB_AUTH: 'true', userDbStub });
    const req = makeRequest('/api/ssh?token=987:one-time-token', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(401);
  });

  it('强制登录时一次性连接 token 必须属于当前 GitHub 用户', async () => {
    const worker = await loadWorker();
    const userDbStub = makeDOStub((request) => {
      if (request.url.includes('/internal/session/verify')) {
        return Response.json({
          id: 12,
          github_id: 42,
          username: 'alice',
          avatar_url: '',
        });
      }
      if (request.url.includes('/internal/connect-token/consume')) {
        return Response.json({
          host: 'ssh.example.com',
          port: 22,
          username: 'bob',
          password: 'secret',
          userId: '99',
          githubId: '987',
        });
      }
      return Response.json({ error: 'not mocked' }, { status: 500 });
    });
    const sshSessionStub = makeDOStub(() => new Response('forwarded'));
    const env = makeEnv({
      REQUIRE_GITHUB_AUTH: 'true',
      userDbStub,
      sshSessionStub,
    });
    const req = makeRequest('/api/ssh?token=987:one-time-token', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      cookies: { session: '42:session-token' },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    expect(sshSessionStub.fetch).not.toHaveBeenCalled();
  });

  it('伪造的 connect token → 403 Invalid or expired connection token', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      userDbStub: makeDOStub(() => new Response('{"error":"invalid"}', { status: 403 })),
    });

    const req = makeRequest('/api/ssh?token=forged_token_xyz', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://cloudssh.test',
      },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    const data = await res.json();
    expect((data as { error?: string }).error).toMatch(/token|无效|expired/i);
  });

  it('SFTP attach 缺 session 参数 → 403 Missing SFTP attach token', async () => {
    const worker = await loadWorker();
    const env = makeEnv();

    // 合法 Origin、合法 Upgrade，但缺 session 和 token
    const req = makeRequest('/api/ssh/sftp', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://cloudssh.test',
      },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    const data = await res.json();
    expect((data as { error?: string }).error).toMatch(/token|missing/i);
  });
});

describe('安全 — 一次性 SSH 分享边界', () => {
  it('分享功能默认关闭，仅显式配置 true 时公开', async () => {
    const worker = await loadWorker();
    const disabled = await worker.fetch(makeRequest('/api/config'), makeEnv());
    expect(((await disabled.json()) as { sshSharingEnabled?: boolean }).sshSharingEnabled).toBe(
      false
    );

    const enabled = await worker.fetch(
      makeRequest('/api/config'),
      makeEnv({ ENABLE_SSH_SHARING: 'true' })
    );
    expect(((await enabled.json()) as { sshSharingEnabled?: boolean }).sshSharingEnabled).toBe(
      true
    );
  });

  it('公开领取接口对非法 JSON 和非 URL-safe 凭证返回 400', async () => {
    const worker = await loadWorker();
    const env = makeEnv({ ENABLE_SSH_SHARING: 'true' });
    const malformed = await worker.fetch(
      makeRequest('/api/share/claim', {
        method: 'POST',
        body: '{',
      }),
      env
    );
    const invalidToken = await worker.fetch(
      makeRequest('/api/share/claim', {
        method: 'POST',
        body: { token: '非'.repeat(40) },
      }),
      env
    );

    expect(malformed.status).toBe(400);
    expect(invalidToken.status).toBe(400);
  });

  it('领取接口只返回短期 WebSocket 票据，不把原始分享凭证放入连接 URL', async () => {
    const worker = await loadWorker();
    const token = 'a'.repeat(43);
    const shareStub = makeDOStub((request) => {
      expect(request.url).toContain('/internal/claim');
      return Response.json({
        ticket: 'b'.repeat(43),
        serverName: 'production',
        sessionExpiresAt: Date.now() + 60_000,
      });
    });
    const idFromName = vi.fn(() => 'share-do');
    const env = makeEnv({ ENABLE_SSH_SHARING: 'true', sshShareStub: shareStub });
    env.SSH_SHARE = { idFromName, get: () => shareStub } as any;

    const response = await worker.fetch(
      makeRequest('/api/share/claim', {
        method: 'POST',
        body: { token },
      }),
      env
    );
    const payload = (await response.json()) as { wsUrl: string };

    expect(response.status).toBe(200);
    expect(payload.wsUrl).toContain('share_ticket=');
    expect(payload.wsUrl).toContain('share_ref=');
    expect(payload.wsUrl).not.toContain(token);
    expect(idFromName).toHaveBeenCalledTimes(1);
  });

  it('创建链接时只向 ShareDO 传递凭证哈希和服务器索引', async () => {
    const worker = await loadWorker();
    let metadataBody: Record<string, unknown> | undefined;
    let initBody: Record<string, unknown> | undefined;
    const userDbStub = makeDOStub(async (request) => {
      if (request.url.includes('/internal/session/verify')) {
        return Response.json({ id: 12, github_id: 987, username: 'alice', avatar_url: '' });
      }
      if (request.url.includes('/internal/servers/7/shares') && request.method === 'POST') {
        metadataBody = await request.json<Record<string, unknown>>();
        return Response.json(
          {
            serverName: 'production',
            expiresAt: metadataBody.expires_at,
            maxSessionSeconds: metadataBody.max_session_seconds,
          },
          { status: 201 }
        );
      }
      return Response.json({ error: 'not mocked' }, { status: 500 });
    });
    const shareStub = makeDOStub(async (request) => {
      initBody = await request.json<Record<string, unknown>>();
      return Response.json({ success: true });
    });
    const env = makeEnv({ ENABLE_SSH_SHARING: 'true', userDbStub, sshShareStub: shareStub });

    const response = await worker.fetch(
      makeRequest('/api/servers/7/shares', {
        method: 'POST',
        cookies: { session: '987:legit-session' },
        body: { expiresInMinutes: 15, maxSessionMinutes: 60 },
      }),
      env
    );
    const payload = (await response.json()) as { url: string; id: string };
    const token = payload.url.split('/#/share/')[1];

    expect(response.status).toBe(201);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(metadataBody).toEqual(
      expect.objectContaining({
        user_id: 12,
        share_id: payload.id,
        max_session_seconds: 3600,
      })
    );
    expect(initBody).toEqual(
      expect.objectContaining({
        shareId: payload.id,
        ownerUserId: 12,
        ownerGithubId: '987',
        serverId: 7,
        serverName: 'production',
        maxSessionSeconds: 3600,
      })
    );
    expect(initBody?.tokenHash).toBe(metadataBody?.share_ref);
    expect(initBody?.tokenHash).not.toBe(token);
    expect(JSON.stringify(initBody)).not.toContain('password');
    expect(JSON.stringify(initBody)).not.toContain('privateKey');
    expect(JSON.stringify(initBody)).not.toContain('ssh.example.com');
  });

  it('分享 WebSocket 必须同源，并只接受 ShareDO 签发的内部会话策略', async () => {
    const worker = await loadWorker();
    const shareRef = 'r'.repeat(43);
    const ticket = 't'.repeat(43);
    const shareStub = makeDOStub(() =>
      Response.json({
        serverName: 'production',
        config: {
          host: 'ssh.example.com',
          port: 22,
          username: 'alice',
          password: 'secret',
          githubId: '987',
          expectedFingerprint: 'SHA256:known',
          sessionPolicy: {
            source: 'share',
            shareId: 'share-1',
            shareRef,
            allowAgent: false,
            allowSftp: true,
            allowMetadataMutation: false,
            allowHostKeyMutation: false,
            allowReconnect: false,
            sessionExpiresAt: Date.now() + 60_000,
          },
        },
      })
    );
    let forwardedConfig: any;
    const sessionStub = makeDOStub((request) => {
      forwardedConfig = JSON.parse(decodeURIComponent(request.headers.get('x-ssh-config')!));
      return new Response('forwarded');
    });
    const env = makeEnv({
      ENABLE_SSH_SHARING: 'true',
      REQUIRE_GITHUB_AUTH: 'true',
      sshShareStub: shareStub,
      sshSessionStub: sessionStub,
    });

    const missingOrigin = await worker.fetch(
      makeRequest(`/api/ssh?share_ref=${shareRef}&share_ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      env
    );
    expect(missingOrigin.status).toBe(403);

    const accepted = await worker.fetch(
      makeRequest(`/api/ssh?share_ref=${shareRef}&share_ticket=${ticket}`, {
        headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      }),
      env
    );
    expect(accepted.status).toBe(200);
    expect(forwardedConfig.sessionPolicy).toEqual(
      expect.objectContaining({
        source: 'share',
        allowAgent: false,
        allowSftp: true,
      })
    );
  });

  it('分享功能关闭时拒绝领取和分享 WebSocket', async () => {
    const worker = await loadWorker();
    const claim = await worker.fetch(
      makeRequest('/api/share/claim', {
        method: 'POST',
        body: { token: 'a'.repeat(43) },
      }),
      makeEnv()
    );
    expect(claim.status).toBe(404);

    const socket = await worker.fetch(
      makeRequest(`/api/ssh?share_ref=${'r'.repeat(43)}&share_ticket=${'t'.repeat(43)}`, {
        headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      }),
      makeEnv()
    );
    expect(socket.status).toBe(404);
  });
});

describe('安全 — 速率限制', () => {
  it('单 IP 触发限流 → 429 Too Many Requests', async () => {
    const worker = await loadWorker();
    const env = makeEnv({});

    const req = new Request('https://cloudssh.test/api/ssh', {
      headers: {
        'CF-Connecting-IP': '203.0.113.1',
        Upgrade: 'websocket',
        Origin: 'https://cloudssh.test',
      },
    });

    // RATE_LIMIT_MAX = 10, 发送 10 次不会 429，第 11 次会 429
    for (let i = 0; i < 10; i++) {
      await worker.fetch(req, env);
    }

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('不同 IP 使用独立计数桶', async () => {
    const worker = await loadWorker();
    const env = makeEnv();
    const requestFor = (ip: string) =>
      makeRequest('/api/ssh', {
        headers: {
          'CF-Connecting-IP': ip,
          Upgrade: 'websocket',
          Origin: 'https://evil.attacker.com',
        },
      });

    for (let i = 0; i < 10; i++) {
      await worker.fetch(requestFor('203.0.113.30'), env);
    }

    expect((await worker.fetch(requestFor('203.0.113.30'), env)).status).toBe(429);
    expect((await worker.fetch(requestFor('203.0.113.31'), env)).status).toBe(403);
  });

  it('限流窗口过期后允许重新请求', async () => {
    const now = vi.spyOn(Date, 'now');
    const startedAt = 1_800_000_000_000;
    now.mockReturnValue(startedAt);
    const worker = await loadWorker();
    const env = makeEnv();
    const request = makeRequest('/api/ssh', {
      headers: {
        'CF-Connecting-IP': '203.0.113.32',
        Upgrade: 'websocket',
        Origin: 'https://evil.attacker.com',
      },
    });

    for (let i = 0; i < 10; i++) {
      await worker.fetch(request, env);
    }
    expect((await worker.fetch(request, env)).status).toBe(429);

    now.mockReturnValue(startedAt + 60_000);
    expect((await worker.fetch(request, env)).status).toBe(403);
    now.mockRestore();
  });

  it('缺少 CF-Connecting-IP 时不共享 unknown 限流桶', async () => {
    const worker = await loadWorker();
    const env = makeEnv();

    for (let i = 0; i < 11; i++) {
      const res = await worker.fetch(
        makeRequest('/api/ssh', {
          headers: { Upgrade: 'websocket', Origin: 'https://evil.attacker.com' },
        }),
        env
      );
      expect(res.status).toBe(403);
    }
  });
});

describe('安全 — SSH 身份字段信任边界', () => {
  it('Agent 使用 githubId 定位分片并用 userId 查询配置', async () => {
    const { SSHSession } = await import('../../src/worker/ssh-session');
    const idFromName = vi.fn(() => 'do-userdb-987');
    let requestedUrl = '';
    const userDbStub = makeDOStub((req) => {
      requestedUrl = req.url;
      return Response.json({
        base_url: 'https://api.example.com/v1',
        model: 'test-model',
        api_key: 'test-key',
      });
    });
    const env = makeEnv();
    env.USER_DB = { idFromName, get: () => userDbStub } as any;
    const session = new SSHSession(
      {} as WebSocket,
      {} as any,
      { host: 'ssh.example.com', port: 22, username: 'alice', password: 'secret' },
      true,
      false,
      undefined,
      env,
      '12',
      '987'
    );

    const config = await (session as any).fetchAgentAIConfig('12', '987');

    expect(idFromName).toHaveBeenCalledWith('987');
    expect(requestedUrl).toContain('/internal/ai-config/decrypt?user_id=12');
    expect(config?.model).toBe('test-model');
  });
});
