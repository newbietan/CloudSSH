import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import {
  buildAdminPasswordHash,
  DEFAULT_HASH_ITERATIONS,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  MIN_PASSWORD_LENGTH,
  stretchAdminPassword,
} from '../../frontend/src/password-stretch';

// =====================================================================
// password-auth.test.ts
// ---------------------------------------------------------------
// 单管理员密码登录（与 GitHub OAuth 互斥）回归测试：
//   1. 模式解析 — /api/config 的 authMode/passwordAuth/passwordHashInvalid
//   2. 登录端点 — Origin/格式/坏哈希/节流/恒时比对/Set-Cookie
//   3. 双向模式门 — 密码模式拒绝 GitHub 会话与令牌，反之亦然
//   4. GitHub 路由 501 — 密码模式下唯一建用户入口被堵死
//   5. UserDB 内部路由 — 登录节流状态机/本地管理员 upsert/会话令牌
//   6. 纯函数 — parseAdminPasswordHash / resolveAuthMode
//
// Worker 级用例走 default export 的 fetch 入口（最接近真实攻击路径），
// DO stub 与 global.fetch 用 vi.fn() mock（同 security.test.ts 模式）。
// =====================================================================

async function loadWorker() {
  const mod = await import('../../src/worker/index');
  return mod.default;
}

// ---------- 密码哈希/密钥构造（与 scripts/hash-password.mjs 同口径） ----------

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function makeAdminHash(
  password: string,
  iterations = 1000
): Promise<{ hash: string; key: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const stretched = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      baseKey,
      256
    )
  );
  const verifier = new Uint8Array(await crypto.subtle.digest('SHA-256', stretched));
  return { hash: `pbkdf2$sha256$${iterations}$${b64url(salt)}$${b64url(verifier)}`, key: b64url(stretched) };
}

/** 会话令牌指纹 = ADMIN_PASSWORD_HASH 的 SHA-256 前 8 hex（与 auth.ts 口径一致） */
async function hashFingerprint(hash: string): Promise<string> {
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hash)));
  return digest.toString('hex').slice(0, 8);
}

function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------- mock helpers ----------

interface ThrottleState {
  failCount: number;
  lockedUntil: number;
}

/** 有状态 UserDB stub：实现登录/会话链路所需的全部内部路由 */
function makeUserDbStub(options: { lockThrottle?: boolean } = {}) {
  const sessions = new Map<string, { user_id: number }>();
  const throttle: ThrottleState = { failCount: 0, lockedUntil: 0 };
  const adminUser = { id: 1, github_id: -1, username: 'admin', avatar_url: null };
  const calls: string[] = [];

  const stub = {
    sessions,
    throttle,
    calls,
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      calls.push(path);

      if (path === '/internal/login-throttle') {
        const { action } = (await req.json()) as { action: string };
        if (action === 'check') {
          if (options.lockThrottle) {
            return Response.json({ locked: true, retryAfterSec: 300 });
          }
          return Response.json({ locked: false, retryAfterSec: 0 });
        }
        if (action === 'fail') {
          throttle.failCount++;
          return Response.json({ locked: false, retryAfterSec: 0 });
        }
        if (action === 'reset') {
          throttle.failCount = 0;
          return Response.json({ locked: false, retryAfterSec: 0 });
        }
        return Response.json({ error: 'Invalid action' }, { status: 400 });
      }

      if (path === '/internal/local-admin-user') {
        return Response.json(adminUser);
      }

      if (path === '/internal/session/create') {
        const body = (await req.json()) as { user_id: number; token?: string };
        const token = body.token ?? `github:${randomHex()}`;
        sessions.set(token, { user_id: body.user_id });
        return Response.json({ token, expires_at: new Date().toISOString() });
      }

      if (path === '/internal/session/verify') {
        const { token } = (await req.json()) as { token: string };
        if (!sessions.has(token)) {
          return Response.json({ error: 'Invalid or expired session' }, { status: 401 });
        }
        return Response.json(adminUser);
      }

      if (path === '/internal/session/delete') {
        const { token } = (await req.json()) as { token: string };
        sessions.delete(token);
        return Response.json({ success: true });
      }

      return Response.json({ error: 'not mocked' }, { status: 500 });
    }),
  };
  return stub;
}

function makeEnv(
  overrides: Partial<Env> & { userDbStub?: ReturnType<typeof makeUserDbStub> } = {}
): Env {
  const { userDbStub, ...rest } = overrides;
  const defaultStub = { fetch: vi.fn(async () => new Response('{"error":"not mocked"}', { status: 500 })) };
  const stub = userDbStub ?? defaultStub;
  return {
    SSH_SESSION: { idFromName: () => 'do-ssh', get: () => stub } as unknown as Env['SSH_SESSION'],
    USER_DB: { idFromName: () => 'do-userdb', get: () => stub } as unknown as Env['USER_DB'],
    SSH_SHARE: { idFromName: () => 'do-share', get: () => stub } as unknown as Env['SSH_SHARE'],
    ...rest,
  } as Env;
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
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

// ---------- global fetch mock（Turnstile 站点验证等外呼） ----------

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = undefined;
});

// =====================================================================
// 8. 管理员密码哈希四方口径对齐（生成器 ↔ 登录预拉伸 ↔ 服务端解析 ↔ 脚本）
// =====================================================================

describe('管理员密码哈希四方口径对齐', () => {
  it('浏览器生成器输出可被服务端 parseAdminPasswordHash 解析', async () => {
    const hash = await buildAdminPasswordHash('browser-custom-password', 1000);
    expect(hash).toMatch(/^pbkdf2\$sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);

    const parsed = parseAdminPasswordHash(hash);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toBe('invalid');
    if (parsed && parsed !== 'invalid' && parsed !== null) {
      expect(parsed.iterations).toBe(1000);
      // 与 scripts/hash-password.mjs 的 SALT_BYTES / verifier 口径一致
      expect(parsed.salt.length).toBe(16);
      expect(parsed.verifier.length).toBe(32);
    }
  });

  it('登录预拉伸密钥经 SHA-256 与生成器 verifier 完全一致（完整登录链路）', async () => {
    const password = 'roundtrip-password';
    const hash = await buildAdminPasswordHash(password, 1000);
    const [, , , saltB64url] = hash.split('$');

    // 浏览器登录时：按 /api/config 公开参数本地预拉伸
    const stretchedB64url = await stretchAdminPassword(password, saltB64url, 1000);
    const stretched = Buffer.from(stretchedB64url, 'base64url');
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', stretched));

    // 服务端：SHA-256(key) 恒时比对 verifier
    const parsed = parseAdminPasswordHash(hash);
    expect(
      parsed && parsed !== 'invalid' && parsed !== null ? Buffer.from(parsed.verifier) : null
    ).toEqual(digest);
  });

  it('错误密码的拉伸结果不匹配 verifier（比对的另一侧必然不等）', async () => {
    const hash = await buildAdminPasswordHash('correct-password', 1000);
    const [, , , saltB64url] = hash.split('$');

    const stretchedB64url = await stretchAdminPassword('wrong-password', saltB64url, 1000);
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(stretchedB64url, 'base64url')));

    const parsed = parseAdminPasswordHash(hash);
    expect(
      parsed && parsed !== 'invalid' && parsed !== null ? Buffer.from(parsed.verifier) : null
    ).not.toEqual(digest);
  });

  it('生成器默认迭代数与口径常量一致（OWASP 推荐下限，与脚本默认值一致）', async () => {
    const hash = await buildAdminPasswordHash('default-iterations-password');
    const parsed = parseAdminPasswordHash(hash);
    expect(DEFAULT_HASH_ITERATIONS).toBe(600000);
    expect(
      parsed && parsed !== 'invalid' && parsed !== null ? parsed.iterations : 0
    ).toBe(DEFAULT_HASH_ITERATIONS);
  });

  it('预拉伸参数边界：迭代数越界抛错，盐过短抛错', async () => {
    const hash = await buildAdminPasswordHash('bounds-password', 1000);
    const [, , , saltB64url] = hash.split('$');

    await expect(stretchAdminPassword('p', saltB64url, MIN_ITERATIONS - 1)).rejects.toThrow();
    await expect(stretchAdminPassword('p', saltB64url, MAX_ITERATIONS + 1)).rejects.toThrow();
    await expect(stretchAdminPassword('p', 'too-short', 1000)).rejects.toThrow();
    expect(MIN_PASSWORD_LENGTH).toBe(10);
  });
});

// =====================================================================
// 1. 模式解析 — /api/config
// =====================================================================

describe('密码认证 — 模式解析（/api/config）', () => {
  it('无任何认证变量 → 匿名模式，GitHub 入口关闭', async () => {
    const worker = await loadWorker();
    const res = await worker.fetch(makeRequest('/api/config'), makeEnv());
    const config = await res.json<{
      authMode: string;
      githubAuthEnabled: boolean;
      passwordAuth: unknown;
      passwordHashInvalid: boolean;
    }>();
    expect(config.authMode).toBe('anonymous');
    expect(config.githubAuthEnabled).toBe(false);
    expect(config.passwordAuth).toBeNull();
    expect(config.passwordHashInvalid).toBe(false);
  });

  it('仅 GitHub 凭据 → GitHub 模式', async () => {
    const worker = await loadWorker();
    const env = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec' });
    const res = await worker.fetch(makeRequest('/api/config'), env);
    const config = await res.json<{ authMode: string; githubAuthEnabled: boolean }>();
    expect(config.authMode).toBe('github');
    expect(config.githubAuthEnabled).toBe(true);
  });

  it('合法哈希 → 密码模式（优先级高于 GitHub），下发公开预拉伸参数', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const env = makeEnv({
      ADMIN_PASSWORD_HASH: hash,
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
    });
    const res = await worker.fetch(makeRequest('/api/config'), env);
    const config = await res.json<{
      authMode: string;
      githubAuthEnabled: boolean;
      passwordAuth: { kdf: string; iterations: number; salt: string } | null;
    }>();
    // 密码优先：GitHub 入口被权威禁用（即使凭据仍在变量里）
    expect(config.authMode).toBe('password');
    expect(config.githubAuthEnabled).toBe(false);
    expect(config.passwordAuth).not.toBeNull();
    expect(config.passwordAuth!.kdf).toBe('pbkdf2-sha256');
    expect(config.passwordAuth!.iterations).toBe(1000);
    expect(config.passwordAuth!.salt).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('哈希为空字符串 → 视同未配置，退回 GitHub 模式（置空即回退语义）', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      ADMIN_PASSWORD_HASH: '   ',
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
    });
    const res = await worker.fetch(makeRequest('/api/config'), env);
    const config = await res.json<{ authMode: string; githubAuthEnabled: boolean }>();
    expect(config.authMode).toBe('github');
    expect(config.githubAuthEnabled).toBe(true);
  });

  it('坏哈希（非空但格式损坏）→ 密码模式 + passwordHashInvalid 标记 + 不下发参数', async () => {
    const worker = await loadWorker();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: 'not-a-valid-hash' });
    const res = await worker.fetch(makeRequest('/api/config'), env);
    const config = await res.json<{
      authMode: string;
      passwordAuth: unknown;
      passwordHashInvalid: boolean;
    }>();
    // 仍为密码模式（fail closed），但登录不可用
    expect(config.authMode).toBe('password');
    expect(config.passwordAuth).toBeNull();
    expect(config.passwordHashInvalid).toBe(true);
  });
});

// =====================================================================
// 2. 登录端点 — POST /api/auth/password/login
// =====================================================================

describe('密码认证 — 登录端点', () => {
  it('未启用密码模式 → 501', async () => {
    const worker = await loadWorker();
    const env = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec' });
    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key: 'x'.repeat(43) },
      }),
      env
    );
    expect(res.status).toBe(501);
  });

  it('坏哈希 → 500 fail closed，绝不静默回退', async () => {
    const worker = await loadWorker();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: 'garbage' });
    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key: 'x'.repeat(43) },
      }),
      env
    );
    expect(res.status).toBe(500);
  });

  it('缺失 Origin 头 → 403（防跨站登录 CSRF）', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash });
    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        body: { key: 'x'.repeat(43) },
      }),
      env
    );
    expect(res.status).toBe(403);
  });

  it('跨站 Origin → 403', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash });
    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
        body: { key: 'x'.repeat(43) },
      }),
      env
    );
    expect(res.status).toBe(403);
  });

  it('非法 JSON 请求体 → 400', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash });
    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: 'not-json',
      }),
      env
    );
    expect(res.status).toBe(400);
  });

  it('密钥格式非法 → 400', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash });
    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key: 'too-short' },
      }),
      env
    );
    expect(res.status).toBe(400);
  });

  it('正确密钥 → 200 + 哨兵前缀会话 cookie（内嵌密码代际指纹）', async () => {
    const worker = await loadWorker();
    const { hash, key } = await makeAdminHash('correct-password');
    const stub = makeUserDbStub();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, userDbStub: stub });

    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key },
      }),
      env
    );

    expect(res.status).toBe(200);
    const user = (await res.json()) as { github_id: number; username: string };
    expect(user.github_id).toBe(-1);
    expect(user.username).toBe('admin');

    // Set-Cookie：session=-1:<fp8>:<randomHex64>
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(/^session=-1:[0-9a-f]{8}:[0-9a-f]{64};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    // DO 侧落库的令牌与 cookie 值一致（三段式，首段哨兵路由键）
    const storedTokens = Array.from(stub.sessions.keys());
    expect(storedTokens).toHaveLength(1);
    const [routeKey, fp, random] = storedTokens[0]!.split(':');
    expect(routeKey).toBe('-1');
    expect(fp).toHaveLength(8);
    expect(random).toHaveLength(64);
  });

  it('错误密钥 → 401 + 节流失败计数入账（DO fail 动作）', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const stub = makeUserDbStub();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, userDbStub: stub });

    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key: b64url(crypto.getRandomValues(new Uint8Array(32))) },
      }),
      env
    );

    expect(res.status).toBe(401);
    expect(stub.throttle.failCount).toBe(1);
    // 不应创建任何会话
    expect(stub.sessions.size).toBe(0);
  });

  it('节流命中锁定 → 429 + retryAfterSec 透传', async () => {
    const worker = await loadWorker();
    const { hash, key } = await makeAdminHash('correct-password');
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, userDbStub: makeUserDbStub({ lockThrottle: true }) });

    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key },
      }),
      env
    );

    expect(res.status).toBe(429);
    const body = (await res.json()) as { retryAfterSec: number };
    expect(body.retryAfterSec).toBe(300);
  });

  it('Turnstile 已配置且缺失 token → 403', async () => {
    const worker = await loadWorker();
    const { hash, key } = await makeAdminHash('correct-password');
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, TURNSTILE_SECRET: 'ts-secret' });

    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key },
      }),
      env
    );

    expect(res.status).toBe(403);
  });

  it('Turnstile 已配置且验证通过 → 继续完成登录', async () => {
    const worker = await loadWorker();
    const { hash, key } = await makeAdminHash('correct-password');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } })
    );
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, TURNSTILE_SECRET: 'ts-secret', userDbStub: makeUserDbStub() });

    const res = await worker.fetch(
      makeRequest('/api/auth/password/login', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.test' },
        body: { key, turnstileToken: 'cf-token' },
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// 3. 双向模式门 — getAuthenticatedUser（/api/auth/me）
// =====================================================================

describe('密码认证 — 双向模式门', () => {
  it('密码模式 + 有效哨兵会话 → 认证通过', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const stub = makeUserDbStub();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, userDbStub: stub });

    // 构造带当前指纹的合法令牌并直接注入 DO 会话表
    const fp = await hashFingerprint(hash);
    const token = `-1:${fp}:${randomHex()}`;
    stub.sessions.set(token, { user_id: 1 });

    const res = await worker.fetch(
      makeRequest('/api/auth/me', { cookies: { session: token } }),
      env
    );
    expect(res.status).toBe(200);
    const user = (await res.json()) as { github_id: number };
    expect(user.github_id).toBe(-1);
  });

  it('密码模式 + GitHub 会话令牌 → 401（模式门在 DO 调用前拒绝）', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const stub = makeUserDbStub();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, userDbStub: stub });

    const res = await worker.fetch(
      makeRequest('/api/auth/me', { cookies: { session: `12345:${randomHex()}` } }),
      env
    );
    expect(res.status).toBe(401);
    // GitHub 会话不应被送进哨兵 DO 验证
    expect(stub.calls).not.toContain('/internal/session/verify');
  });

  it('密码模式 + 旧密码代际指纹（换密码后的残留会话）→ 401', async () => {
    const worker = await loadWorker();
    const oldHash = (await makeAdminHash('old-password')).hash;
    const { hash } = await makeAdminHash('new-password');
    const stub = makeUserDbStub();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, userDbStub: stub });

    // 用旧哈希指纹构造的令牌在 DO 里有有效会话行，但当前指纹已轮换
    const oldFp = await hashFingerprint(oldHash);
    const token = `-1:${oldFp}:${randomHex()}`;
    stub.sessions.set(token, { user_id: 1 });

    const res = await worker.fetch(
      makeRequest('/api/auth/me', { cookies: { session: token } }),
      env
    );
    expect(res.status).toBe(401);
  });

  it('GitHub 模式 + 哨兵会话令牌 → 401（移除哈希后旧管理员 cookie 失效）', async () => {
    const worker = await loadWorker();
    const stub = makeUserDbStub();
    const env = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec', userDbStub: stub });

    // 哨兵令牌即使两段式（旧格式）也拒绝
    const res = await worker.fetch(
      makeRequest('/api/auth/me', { cookies: { session: `-1:${randomHex()}` } }),
      env
    );
    expect(res.status).toBe(401);
    expect(stub.calls).not.toContain('/internal/session/verify');
  });
});

// =====================================================================
// 4. GitHub 路由在密码模式下 501（堵死唯一建用户入口）
// =====================================================================

describe('密码认证 — GitHub 路由权威禁用', () => {
  it('GET /api/auth/github → 501（含模式提示）', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, GITHUB_CLIENT_ID: 'cid' });

    const res = await worker.fetch(makeRequest('/api/auth/github'), env);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/password auth mode/i);
    // 不得跳转 GitHub
    expect(res.headers.get('Location')).toBeNull();
  });

  it('GET /api/auth/callback → 501（不 upsert 任何用户）', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const env = makeEnv({
      ADMIN_PASSWORD_HASH: hash,
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
    });

    const res = await worker.fetch(
      makeRequest('/api/auth/callback?code=x&state=y', { cookies: { oauth_state: 'y' } }),
      env
    );
    expect(res.status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// 5. /api/ssh 一次性令牌路径的模式门
// =====================================================================

describe('密码认证 — SSH 连接令牌模式门', () => {
  it('密码模式 + GitHub 键令牌 → 403（DO 消费前拒绝）', async () => {
    const worker = await loadWorker();
    const { hash } = await makeAdminHash('correct-password');
    const stub = makeUserDbStub();
    const env = makeEnv({ ADMIN_PASSWORD_HASH: hash, userDbStub: stub });

    const res = await worker.fetch(
      makeRequest('/api/ssh?token=12345:some-uuid', {
        headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      }),
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/different auth mode/i);
    expect(stub.calls).not.toContain('/internal/connect-token/consume');
  });

  it('GitHub 模式 + 哨兵键令牌 → 403（切换模式前签发的令牌不可消费）', async () => {
    const worker = await loadWorker();
    const stub = makeUserDbStub();
    const env = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csec', userDbStub: stub });

    const res = await worker.fetch(
      makeRequest('/api/ssh?token=-1:some-uuid', {
        headers: { Upgrade: 'websocket', Origin: 'https://cloudssh.test' },
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(stub.calls).not.toContain('/internal/connect-token/consume');
  });
});

// =====================================================================
// 6. 纯函数 — parseAdminPasswordHash / resolveAuthMode
// =====================================================================

import { parseAdminPasswordHash, resolveAuthMode } from '../../src/worker/auth';

describe('parseAdminPasswordHash', () => {
  it('未配置/空白 → null（视同关闭）', () => {
    expect(parseAdminPasswordHash(undefined)).toBeNull();
    expect(parseAdminPasswordHash('')).toBeNull();
    expect(parseAdminPasswordHash('   ')).toBeNull();
  });

  it('格式损坏 → invalid（fail closed 依据）', () => {
    expect(parseAdminPasswordHash('garbage')).toBe('invalid');
    expect(parseAdminPasswordHash('pbkdf2$sha256$abc$salt$verifier')).toBe('invalid'); // 非数字迭代
    expect(parseAdminPasswordHash('pbkdf2$sha256$999$salt$verifier')).toBe('invalid'); // 迭代低于下界
    expect(parseAdminPasswordHash('pbkdf2$sha256$11000000$salt$verifier')).toBe('invalid'); // 迭代超上界
    expect(parseAdminPasswordHash('pbkdf2$md5$1000$salt$verifier')).toBe('invalid'); // 非法 KDF
    expect(parseAdminPasswordHash('pbkdf2$sha256$1000$short$verifier')).toBe('invalid'); // 盐过短
    expect(parseAdminPasswordHash('pbkdf2$sha256$1000$salt!=bad$verifier')).toBe('invalid'); // 非法字符
  });

  it('verifier 长度非 32 字节 → invalid', () => {
    // 16 字节 verifier（base64url 22 字符）
    expect(parseAdminPasswordHash('pbkdf2$sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA')).toBe('invalid');
  });

  it('合法格式 → 解析出结构（roundtrip 与浏览器/脚本口径一致）', async () => {
    const { hash } = await makeAdminHash('roundtrip-password', 1000);
    const parsed = parseAdminPasswordHash(hash);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toBe('invalid');
    if (parsed && parsed !== 'invalid' && parsed !== null) {
      expect(parsed.iterations).toBe(1000);
      expect(parsed.salt.length).toBe(16);
      expect(parsed.verifier.length).toBe(32);
    }
  });
});

describe('resolveAuthMode', () => {
  const baseEnv = {} as Env;

  it('密码优先于 GitHub', () => {
    const env = {
      ADMIN_PASSWORD_HASH: 'pbkdf2$sha256$1000$s$v',
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'csec',
    } as Env;
    expect(resolveAuthMode(env)).toBe('password');
  });

  it('空哈希退回 GitHub；半配置 GitHub 不构成有效模式', () => {
    expect(
      resolveAuthMode({
        ADMIN_PASSWORD_HASH: '',
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csec',
      } as Env)
    ).toBe('github');
    // 仅 CLIENT_ID（残留）→ 不算 GitHub 模式
    expect(resolveAuthMode({ ADMIN_PASSWORD_HASH: '', GITHUB_CLIENT_ID: 'cid' } as Env)).toBe(
      'anonymous'
    );
    expect(resolveAuthMode(baseEnv)).toBe('anonymous');
  });
});

// =====================================================================
// 7. UserDB 内部路由 — 节流状态机 / 本地管理员 / 会话令牌
// =====================================================================

import { UserDBDO } from '../../src/worker/user-db';

class FakeSql {
  statements: Array<{ query: string; values: unknown[] }> = [];
  users: Array<{ id: number; github_id: number; username: string; avatar_url: string | null }> = [];
  sessions: Array<{ token: string; user_id: number; expires_at: string }> = [];
  throttle: { fail_count: number; locked_until: number; last_fail_at: number } = {
    fail_count: 0,
    locked_until: 0,
    last_fail_at: 0,
  };
  private nextUserId = 1;

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });
    if (query.includes('CREATE TABLE') || query.includes('CREATE INDEX')) {
      return { toArray: () => [] };
    }
    if (query.includes('PRAGMA table_info')) {
      // 服务器表列齐全 → 跳过列迁移分支；其余表返回空触发幂等 ALTER（无副作用，仅记录）
      if (query.includes('PRAGMA table_info(servers)')) {
        return {
          toArray: () =>
            [
              'region',
              'inferred_hint',
              'tags',
              'os',
              'jump_server_id',
              'transport_type',
              'cf_tunnel_host',
              'cf_access_client_id',
              'cf_access_client_secret',
            ].map((name) => ({ name })) as unknown[],
        };
      }
      if (query.includes('PRAGMA table_info(ssh_shares)')) {
        return { toArray: () => [{ name: 'audit_purged_at' }, { name: 'audit_purge_type' }] as unknown[] };
      }
      if (query.includes('PRAGMA table_info(command_snippets)')) {
        return { toArray: () => [{ name: 'category' }] as unknown[] };
      }
      return { toArray: () => [] };
    }

    if (query.startsWith('INSERT OR IGNORE INTO login_throttle')) {
      return { toArray: () => [] };
    }

    if (query.startsWith('UPDATE login_throttle')) {
      if (values.length === 0) {
        // reset 语句使用字面量零值（无占位符）
        this.throttle = { fail_count: 0, locked_until: 0, last_fail_at: 0 };
      } else {
        this.throttle = {
          fail_count: values[0] as number,
          locked_until: values[1] as number,
          last_fail_at: values[2] as number,
        };
      }
      return { toArray: () => [] };
    }

    if (query.startsWith('INSERT INTO users')) {
      const user = {
        id: this.nextUserId++,
        github_id: values[0] as number,
        username: values[1] as string,
        avatar_url: (values[2] as string | null) ?? null,
      };
      this.users.push(user);
      return { toArray: () => [] };
    }

    if (query.startsWith('INSERT INTO sessions')) {
      this.sessions.push({
        token: values[0] as string,
        user_id: values[1] as number,
        expires_at: values[2] as string,
      });
      return { toArray: () => [] };
    }

    // SELECT：DO 的 query<T> 是 exec 的薄封装，全部在此路由
    if (query.includes('FROM login_throttle WHERE id = 1')) {
      return { toArray: () => [{ ...this.throttle }] };
    }
    if (query.includes('FROM users WHERE github_id = ?')) {
      const gid = values[0] as number;
      return { toArray: () => this.users.filter((u) => u.github_id === gid) };
    }
    if (query.startsWith('SELECT github_id FROM users WHERE id = ?')) {
      const uid = values[0] as number;
      const found = this.users.find((u) => u.id === uid);
      return { toArray: () => (found ? [{ github_id: found.github_id }] : []) };
    }

    return { toArray: () => [] };
  }

  query<T>(query: string, ...values: unknown[]): T[] {
    // UserDBDO.query<T> 亦走 exec，此处仅提供测试便捷入口
    return this.exec(query, ...values).toArray() as T[];
  }
}

function createUserDB(sql: FakeSql): UserDBDO {
  return new UserDBDO({ storage: { sql } } as unknown as DurableObjectState, {
    DEBUG_MODE: 'false',
  } as never);
}

function jsonRequest(url: string, init: RequestInit): Request {
  return new Request(url, init);
}

describe('UserDB — 登录节流状态机', () => {
  it('建表语句包含 login_throttle 单行表', () => {
    const sql = new FakeSql();
    createUserDB(sql);
    const hasTable = sql.statements.some((s) => s.query.includes('CREATE TABLE IF NOT EXISTS login_throttle'));
    expect(hasTable).toBe(true);
  });

  it('check：初始未锁定', async () => {
    const db = createUserDB(new FakeSql());
    const res = await db.fetch(
      jsonRequest('http://internal/internal/login-throttle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check' }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locked: boolean; retryAfterSec: number };
    expect(body.locked).toBe(false);
    expect(body.retryAfterSec).toBe(0);
  });

  it('fail×4 未锁，第 5 次起指数退避锁定（60s 起）', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);

    for (let i = 1; i <= 4; i++) {
      const res = await db.fetch(
        jsonRequest('http://internal/internal/login-throttle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'fail' }),
        })
      );
      const body = (await res.json()) as { locked: boolean };
      expect(body.locked).toBe(false);
    }
    expect(sql.throttle.fail_count).toBe(4);

    const fifth = await db.fetch(
      jsonRequest('http://internal/internal/login-throttle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fail' }),
      })
    );
    const fifthBody = (await fifth.json()) as { locked: boolean; retryAfterSec: number };
    expect(fifthBody.locked).toBe(true);
    expect(fifthBody.retryAfterSec).toBeGreaterThan(0);
    expect(fifthBody.retryAfterSec).toBeLessThanOrEqual(60);
    // locked_until = now + 60s
    expect(sql.throttle.locked_until).toBeGreaterThan(Date.now());
  });

  it('连败继续加深退避（封顶 15 分钟）', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);

    const fail = async () =>
      db.fetch(
        jsonRequest('http://internal/internal/login-throttle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'fail' }),
        })
      );
    for (let i = 0; i < 12; i++) await fail();

    expect(sql.throttle.fail_count).toBe(12);
    const backoffSec = (sql.throttle.locked_until - Date.now()) / 1000;
    // 60 * 2^(12-5) = 7680s > 900s 封顶
    expect(backoffSec).toBeLessThanOrEqual(900 + 1);
    expect(backoffSec).toBeGreaterThan(890);
  });

  it('reset：登录成功后清零', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);

    await db.fetch(
      jsonRequest('http://internal/internal/login-throttle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fail' }),
      })
    );
    await db.fetch(
      jsonRequest('http://internal/internal/login-throttle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
    );
    expect(sql.throttle.fail_count).toBe(0);
    expect(sql.throttle.locked_until).toBe(0);
  });

  it('连败衰减：距上次失败超过锁定封顶时长 → 重新计数', async () => {
    const sql = new FakeSql();
    // 预置 4 次连败，且上次失败发生在 20 分钟前（超过 15 分钟封顶）
    sql.throttle = { fail_count: 4, locked_until: 0, last_fail_at: Date.now() - 20 * 60 * 1000 };
    const db = createUserDB(sql);

    const res = await db.fetch(
      jsonRequest('http://internal/internal/login-throttle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fail' }),
      })
    );
    const body = (await res.json()) as { locked: boolean };
    // 衰减后视作新一轮第 1 次失败，不锁定
    expect(body.locked).toBe(false);
    expect(sql.throttle.fail_count).toBe(1);
  });

  it('非法 action → 400', async () => {
    const db = createUserDB(new FakeSql());
    const res = await db.fetch(
      jsonRequest('http://internal/internal/login-throttle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'nope' }),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('UserDB — 本地管理员 upsert', () => {
  it('首次调用创建哨兵用户行（github_id = -1，username = admin），幂等返回', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);

    const first = await db.fetch(
      jsonRequest('http://internal/internal/local-admin-user', { method: 'POST', body: '{}' })
    );
    expect(first.status).toBe(200);
    const user = (await first.json()) as { github_id: number; username: string; avatar_url: string | null };
    expect(user.github_id).toBe(-1);
    expect(user.username).toBe('admin');
    expect(user.avatar_url).toBeNull();

    // 第二次调用：存在即返回，不重复 INSERT
    const before = sql.users.length;
    const second = await db.fetch(
      jsonRequest('http://internal/internal/local-admin-user', { method: 'POST', body: '{}' })
    );
    expect(second.status).toBe(200);
    expect(sql.users.length).toBe(before);
    expect((await second.json() as { github_id: number }).github_id).toBe(-1);
  });
});

describe('UserDB — 会话创建支持可信预生成令牌', () => {
  it('提供 token 时按原样落库（本地管理员三段式）；未提供时沿用 github_id:random 生成', async () => {
    const sql = new FakeSql();
    sql.users.push({ id: 1, github_id: -1, username: 'admin', avatar_url: null });
    sql.users.push({ id: 2, github_id: 12345, username: 'octocat', avatar_url: 'https://x/a.png' });
    const db = createUserDB(sql);

    await db.fetch(
      jsonRequest('http://internal/internal/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 1, token: '-1:abcdef12:cafebabe' }),
      })
    );
    expect(sql.sessions.some((s) => s.token === '-1:abcdef12:cafebabe')).toBe(true);

    // 不带 token：github 用户走原有生成路径
    await db.fetch(
      jsonRequest('http://internal/internal/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 2 }),
      })
    );
    const githubToken = sql.sessions.find((s) => s.user_id === 2);
    expect(githubToken).toBeDefined();
    expect(githubToken!.token).toMatch(/^12345:[0-9a-f]{64}$/);
  });

  it('非法 token 格式被拒绝，退回服务端生成', async () => {
    const sql = new FakeSql();
    sql.users.push({ id: 1, github_id: -1, username: 'admin', avatar_url: null });
    const db = createUserDB(sql);

    const res = await db.fetch(
      jsonRequest('http://internal/internal/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 1, token: 'bad token with spaces:!!' }),
      })
    );
    expect(res.status).toBe(200);
    // 非法 token 不落库，退回 -1:random 生成
    expect(sql.sessions.some((s) => s.token.includes(' '))).toBe(false);
    expect(sql.sessions[0]!.token).toMatch(/^-1:[0-9a-f]{64}$/);
  });
});
