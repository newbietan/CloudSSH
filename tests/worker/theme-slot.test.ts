import { describe, expect, it, vi } from 'vitest';
import type { Env, UserInfo } from '../../src/types';

// =====================================================================
// theme-slot.test.ts
// ---------------------------------------------------------------
// 云端自定义主题槽生命周期回归测试：
//   1. DELETE /api/user/theme —— 登录态回归内置时清除云端槽
//      （未登录 401；登录后携带 user_id 转发到哨兵 DO；幂等语义）
//   2. GET/PUT 路由行为不回归
//   3. UserDBDO handleDeleteTheme —— 删除 SQL 正确落库
//
// 背景：restoreCloudTheme 的“匿名导入回填”曾把浏览器残留的陈旧导入上传到
// 全新账号（如密码模式新建管理员）的云端主题槽；修复后回填仅在本地选择
// 停留在 __custom__ 时触发，且回归内置会同步清除本地缓存与云端槽。
// =====================================================================

async function loadWorker() {
  const mod = await import('../../src/worker/index');
  return mod.default;
}

interface ThemeStubOptions {
  sessionToken?: string;
  user?: UserInfo;
  theme?: unknown;
}

/** 有状态 UserDB stub：会话验证 + 主题槽 GET/PUT/DELETE 记录 */
function makeThemeStub(options: ThemeStubOptions) {
  const user: UserInfo = options.user ?? {
    id: 1,
    github_id: 12345,
    username: 'octocat',
    avatar_url: null,
  };
  const sessions = new Set<string>(options.sessionToken ? [options.sessionToken] : []);
  const calls: Array<{ path: string; method: string; userId: string | null }> = [];

  const stub = {
    calls,
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      calls.push({ path, method: req.method, userId: url.searchParams.get('user_id') });

      if (path === '/internal/session/verify') {
        const { token } = (await req.json()) as { token: string };
        if (!sessions.has(token)) {
          return Response.json({ error: 'Invalid or expired session' }, { status: 401 });
        }
        return Response.json(user);
      }

      if (path === '/internal/theme') {
        if (req.method === 'GET') return Response.json({ theme: options.theme ?? null });
        if (req.method === 'PUT') return Response.json({ success: true });
        if (req.method === 'DELETE') return Response.json({ success: true });
      }

      return Response.json({ error: 'not mocked' }, { status: 500 });
    }),
  };
  return stub;
}

function makeEnv(userDbStub: ReturnType<typeof makeThemeStub>): Env {
  const fallback = { fetch: vi.fn(async () => new Response('{"error":"not mocked"}', { status: 500 })) };
  return {
    SSH_SESSION: { idFromName: () => 'do-ssh', get: () => fallback } as unknown as Env['SSH_SESSION'],
    USER_DB: { idFromName: () => 'do-userdb', get: () => userDbStub } as unknown as Env['USER_DB'],
    SSH_SHARE: { idFromName: () => 'do-share', get: () => fallback } as unknown as Env['SSH_SHARE'],
  } as Env;
}

function makeRequest(
  path: string,
  opts: { method?: string; cookies?: Record<string, string>; body?: unknown } = {}
): Request {
  const url = new URL(`https://cloudssh.test${path}`);
  const headers: Record<string, string> = {};
  if (opts.cookies) {
    headers['Cookie'] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return new Request(url.toString(), init);
}

const SESSION_TOKEN = '12345:abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678';

describe('云端主题槽 — DELETE /api/user/theme', () => {
  it('未登录 → 401，不触碰 DO', async () => {
    const worker = await loadWorker();
    const stub = makeThemeStub({});
    const res = await worker.fetch(makeRequest('/api/user/theme', { method: 'DELETE' }), makeEnv(stub));
    expect(res.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
  });

  it('登录态 → 200，携带 user_id 以 DELETE 转发到 UserDBDO', async () => {
    const worker = await loadWorker();
    const stub = makeThemeStub({ sessionToken: SESSION_TOKEN });
    const res = await worker.fetch(
      makeRequest('/api/user/theme', { method: 'DELETE', cookies: { session: SESSION_TOKEN } }),
      makeEnv(stub)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const themeDelete = stub.calls.find((c) => c.path === '/internal/theme' && c.method === 'DELETE');
    expect(themeDelete).toBeDefined();
    expect(themeDelete!.userId).toBe('1');
  });

  it('会话校验仍走 session/verify（GitHub 模式会话；密码模式会话的完整验证见 password-auth.test.ts）', async () => {
    const worker = await loadWorker();
    const stub = makeThemeStub({ sessionToken: SESSION_TOKEN });
    const env = makeEnv(stub);
    env.GITHUB_CLIENT_ID = 'cid';
    env.GITHUB_CLIENT_SECRET = 'csec';
    const res = await worker.fetch(
      makeRequest('/api/user/theme', { method: 'DELETE', cookies: { session: SESSION_TOKEN } }),
      env
    );
    expect(res.status).toBe(200);
    expect(stub.calls.some((c) => c.path === '/internal/session/verify')).toBe(true);
  });
});

describe('云端主题槽 — 既有路由不回归', () => {
  it('GET 登录态 → 返回主题载荷', async () => {
    const worker = await loadWorker();
    const stub = makeThemeStub({ sessionToken: SESSION_TOKEN, theme: { version: 4 } });
    const res = await worker.fetch(
      makeRequest('/api/user/theme', { cookies: { session: SESSION_TOKEN } }),
      makeEnv(stub)
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { theme: unknown };
    expect(payload.theme).toEqual({ version: 4 });
  });

  it('GET 未登录 → 401', async () => {
    const worker = await loadWorker();
    const stub = makeThemeStub({});
    const res = await worker.fetch(makeRequest('/api/user/theme'), makeEnv(stub));
    expect(res.status).toBe(401);
  });
});

// =====================================================================
// UserDBDO — handleDeleteTheme（FakeSql 模式）
// =====================================================================

import { UserDBDO } from '../../src/worker/user-db';

class FakeSql {
  statements: Array<{ query: string; values: unknown[] }> = [];

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });
    if (query.includes('CREATE TABLE') || query.includes('CREATE INDEX')) {
      return { toArray: () => [] };
    }
    if (query.includes('PRAGMA table_info')) {
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
    return { toArray: () => [] };
  }

  query<T>(query: string, ...values: unknown[]): T[] {
    return this.exec(query, ...values).toArray() as T[];
  }
}

function createUserDB(sql: FakeSql): UserDBDO {
  return new UserDBDO({ storage: { sql } } as unknown as DurableObjectState, {
    DEBUG_MODE: 'false',
  } as never);
}

describe('UserDBDO — 主题槽删除', () => {
  it('DELETE 路由执行按 user_id 的删除语句且幂等返回成功', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);

    const res = await db.fetch(new Request('http://internal/internal/theme?user_id=7', {
      method: 'DELETE',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const del = sql.statements.find((s) => s.query.includes('DELETE FROM user_themes'));
    expect(del).toBeDefined();
    expect(del!.query).toContain('WHERE user_id = ?');
    expect(del!.values).toEqual([7]);

    // 幂等：无行时再次删除仍成功
    const again = await db.fetch(new Request('http://internal/internal/theme?user_id=7', {
      method: 'DELETE',
    }));
    expect(again.status).toBe(200);
  });

  it('DELETE 缺失/非法 user_id → 400', async () => {
    const db = createUserDB(new FakeSql());
    const missing = await db.fetch(
      new Request('http://internal/internal/theme', { method: 'DELETE' })
    );
    expect(missing.status).toBe(400);
    const invalid = await db.fetch(
      new Request('http://internal/internal/theme?user_id=abc', { method: 'DELETE' })
    );
    expect(invalid.status).toBe(400);
  });
});
