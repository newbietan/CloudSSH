import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Env } from '../../src/types';

// =====================================================================
// security.test.ts
// ---------------------------------------------------------------
// CloudSSH worker 外层接缝的安全回归测试。聚焦"关键安全领域"，
// 不追求全分支覆盖——有状态组件走人工测试。
// 
// 用例覆盖五类高危漏洞：
//   1. CSRF        — OAuth 回调 state 校验
//   2. IDOR/越权   — handler 强制覆盖 body.user_id、DO 层二次归属校验
//   3. SSRF 接缝   — AI base_url 经 validateBaseUrl 在路由层拦截
//   4. 签名伪造    — cf_verified cookie HMAC 完整性
//   5. CSWSH       — 跨站 WebSocket 劫持（Origin 校验）
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
function makeEnv(overrides: Partial<Env> & { userDbStub?: any; sshSessionStub?: any } = {}): Env {
  const { userDbStub, sshSessionStub, ...rest } = overrides;
  const defaultStub = makeDOStub(() => new Response('{"error":"not mocked"}', { status: 500 }));
  return {
    SSH_SESSION: { idFromName: () => 'do-ssh', get: () => sshSessionStub ?? defaultStub } as any,
    USER_DB: { idFromName: () => 'do-userdb', get: () => userDbStub ?? defaultStub } as any,
    ...rest,
  } as Env;
}

function makeRequest(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: any; cookies?: Record<string, string> } = {}
): Request {
  const url = new URL(`https://cloudssh.test${path}`);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookies) {
    headers['Cookie'] = Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
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
// 2. index.ts — IDOR / 越权防护（handler 覆盖 body.user_id + DO 二次校验）
// =====================================================================

describe('安全 — 越权防护（IDOR）', () => {
  it('POST /api/servers 时 body 注入 user_id=999 应被 handler 覆盖为真实 user.id', async () => {
    const worker = await loadWorker();
    // 用户真实 id=1，攻击者在 body 里塞 user_id=999 想把服务器存到别人名下
    let capturedBody: any;
    const env = makeEnv({
      userDbStub: makeDOStub(async (req) => {
        if (req.url.includes('/internal/session/verify')) {
          return new Response(JSON.stringify({ id: 1, github_id: 1, username: 'alice', avatar_url: '' }), {
            headers: { 'Content-Type': 'application/json' },
          });
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
          return new Response(JSON.stringify({ id: 1, github_id: 1, username: 'alice', avatar_url: '' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // DO 收到 PUT /internal/servers/:id，检查 belong，属于他人 → 403
        if (req.url.match(/\/internal\/servers\/\d+$/) && req.method === 'PUT') {
          const body = await req.json();
          // 模拟：服务器 record.user_id=2 !== body.user_id=1
          return new Response(JSON.stringify({ error: 'Server does not belong to user' }), { status: 403 });
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

// =====================================================================
// 3. SSRF 接缝 — AI base_url 在路由层经 validateBaseUrl 拦截
// =====================================================================

describe('安全 — SSRF 接缝（AI base_url）', () => {
  it('PUT /api/ai/config base_url=内网地址 → 400', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      userDbStub: makeDOStub(async (req) => {
        if (req.url.includes('/internal/session/verify')) {
          return new Response(JSON.stringify({ id: 1, github_id: 1, username: 'alice', avatar_url: '' }), {
            headers: { 'Content-Type': 'application/json' },
          });
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
    expect(data.error).toBeTruthy(); // validateBaseUrl 返回的中文 reason
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
          return new Response(JSON.stringify({ id: 1, github_id: 42, username: 'alice', avatar_url: '' }), {
            headers: { 'Content-Type': 'application/json' },
          });
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
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1/models' },
    }));

    const req = makeRequest('/api/ai/models', {
      method: 'POST',
      cookies: { session: '42:legit_session' },
      body: { base_url: 'https://api.example.com/v1', api_key: 'test-key' },
    });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});

// =====================================================================
// 4. 签名伪造 — cf_verified cookie HMAC 完整性
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
      new Response(JSON.stringify({ success: false }), { headers: { 'Content-Type': 'application/json' } })
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
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expires));
    const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    // 篡改：把首个字符 a 改成 b（破坏签名）
    const tamperedSig = 'b' + sigHex.slice(1);
    const tamperedToken = `${expires}:${tamperedSig}`;

    // 需要直接调内部函数测——通过路由间接测：
    // 用篡改的 cookie 访问 /api/ssh，HMAC 应失败，走 turnstile 分支
    const req = makeRequest('/api/ssh?turnstile_token=bogus', {
      headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      cookies: { cf_verified: tamperedToken },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), { headers: { 'Content-Type': 'application/json' } })
    );
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(403); // 篡改签名 → 走 turnstile → turnstile 无效 → 403
  });
});

// =====================================================================
// 5. CSWSH — 跨站 WebSocket 劫持（Origin 校验）
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
});

// =====================================================================
// 附：一次性 token 防重放 / SFTP attach 鉴权 / 速率限制
// =====================================================================

describe('安全 — 一次性 token 与接缝鉴权', () => {
  it('connect token 使用 githubId 前缀定位 UserDBDO 分片', async () => {
    const worker = await loadWorker();
    const idFromName = vi.fn(() => 'do-userdb');
    const userDbStub = makeDOStub(() => Response.json({
      host: 'ssh.example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
      userId: '12',
      githubId: '987',
    }));
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
    expect(forwardedConfig).toEqual(expect.objectContaining({
      userId: '12',
      githubId: '987',
    }));
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
    expect(data.error).toMatch(/token|无效|expired/i);
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
    expect(data.error).toMatch(/token|missing/i);
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
    const requestFor = (ip: string) => makeRequest('/api/ssh', {
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
      const res = await worker.fetch(makeRequest('/api/ssh', {
        headers: { Upgrade: 'websocket', Origin: 'https://evil.attacker.com' },
      }), env);
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
      '987',
    );

    const config = await (session as any).fetchAgentAIConfig('12', '987');

    expect(idFromName).toHaveBeenCalledWith('987');
    expect(requestedUrl).toContain('/internal/ai-config/decrypt?user_id=12');
    expect(config?.model).toBe('test-model');
  });
});
