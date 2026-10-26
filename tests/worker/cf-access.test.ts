import { describe, expect, it, vi } from 'vitest';
import type { Env, UserInfo } from '../../src/types';
import {
  CF_ACCESS_USER_GITHUB_ID,
  getAccessUserRouteKey,
  getAuthenticatedUser,
  getCFAccessEmail,
  handleLogout,
  resolveAuthMode,
} from '../../src/worker/auth';
import { UserDBDO } from '../../src/worker/user-db';
import worker from '../../src/worker/index';

class FakeAccessSql {
  users: Array<{ id: number; github_id: number; username: string; avatar_url: string | null }> = [];
  nextId = 1;

  exec(query: string, ...values: unknown[]) {
    if (query.startsWith('INSERT INTO users')) {
      const u = {
        id: this.nextId++,
        github_id: values[0] as number,
        username: values[1] as string,
        avatar_url: (values[2] as string | null) ?? null,
      };
      this.users.push(u);
      return { toArray: () => [] };
    }
    if (query.includes('FROM users WHERE github_id = ?')) {
      const gid = values[0] as number;
      return { toArray: () => this.users.filter((u) => u.github_id === gid) };
    }
    return { toArray: () => [] };
  }
}

function makeDOStub(responder: (req: Request) => Response | Promise<Response>) {
  return {
    fetch: vi.fn((req: Request) => responder(req)),
  };
}

function makeEnv(overrides: Partial<Env> & { userDbStub?: any } = {}): Env {
  const { userDbStub, ...rest } = overrides;
  const defaultStub = makeDOStub(() => new Response('{"error":"not mocked"}', { status: 500 }));
  return {
    SSH_SESSION: { idFromName: () => 'do-ssh', get: () => defaultStub } as any,
    USER_DB: { idFromName: () => 'do-userdb', get: () => userDbStub ?? defaultStub } as any,
    SSH_SHARE: { idFromName: () => 'do-share', get: () => defaultStub } as any,
    ...rest,
  } as Env;
}

describe('Cloudflare Access (Zero Trust) Authentication', () => {
  describe('getCFAccessEmail', () => {
    it('extracts and normalizes valid email from Cf-Access-Authenticated-User-Email header', () => {
      const req = new Request('https://cloudssh.local/', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'User@Example.COM' },
      });
      expect(getCFAccessEmail(req)).toBe('user@example.com');
    });

    it('returns null for missing, empty, or invalid email header', () => {
      expect(getCFAccessEmail(new Request('https://cloudssh.local/'))).toBeNull();
      expect(
        getCFAccessEmail(
          new Request('https://cloudssh.local/', {
            headers: { 'Cf-Access-Authenticated-User-Email': '   ' },
          })
        )
      ).toBeNull();
      expect(
        getCFAccessEmail(
          new Request('https://cloudssh.local/', {
            headers: { 'Cf-Access-Authenticated-User-Email': 'notanemail' },
          })
        )
      ).toBeNull();
    });
  });

  describe('getAccessUserRouteKey', () => {
    it('generates a stable, case-insensitive route key starting with cf:', () => {
      const key1 = getAccessUserRouteKey('Alice@Example.COM');
      const key2 = getAccessUserRouteKey('alice@example.com');
      expect(key1).toBe(key2);
      expect(key1.startsWith('cf:')).toBe(true);
      expect(key1.length).toBeLessThanOrEqual(40);
    });

    it('produces different route keys for different emails', () => {
      const keyA = getAccessUserRouteKey('alice@example.com');
      const keyB = getAccessUserRouteKey('bob@example.com');
      expect(keyA).not.toBe(keyB);
    });
  });

  describe('resolveAuthMode', () => {
    const baseEnv = {} as Env;

    it('prioritizes ADMIN_PASSWORD_HASH if set', () => {
      const env = {
        ADMIN_PASSWORD_HASH: 'pbkdf2$sha256$1000$salt$verifier',
        CF_ACCESS: 'true',
      } as Env;
      const req = new Request('https://cloudssh.local/', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'admin@test.com' },
      });
      expect(resolveAuthMode(env, req)).toBe('password');
    });

    it('detects cf_access from incoming request header', () => {
      const req = new Request('https://cloudssh.local/', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'user@example.com' },
      });
      expect(resolveAuthMode(baseEnv, req)).toBe('cf_access');
    });

    it('detects cf_access if CF_ACCESS is configured true', () => {
      const env = { CF_ACCESS: 'true' } as Env;
      expect(resolveAuthMode(env)).toBe('cf_access');
    });

    it('falls back to github if github credentials are configured', () => {
      const env = {
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'secret',
      } as Env;
      expect(resolveAuthMode(env)).toBe('github');
    });

    it('falls back to anonymous if nothing is configured', () => {
      expect(resolveAuthMode(baseEnv)).toBe('anonymous');
    });
  });

  describe('getAuthenticatedUser under CF Access', () => {
    it('authenticates user via CF Access header and routes to UserDBDO access-user', async () => {
      let requestedBody: any = null;
      let requestedPath = '';
      const userDbStub = makeDOStub(async (req) => {
        requestedPath = new URL(req.url).pathname;
        requestedBody = await req.json();
        return Response.json({
          id: 1,
          github_id: CF_ACCESS_USER_GITHUB_ID,
          username: 'user@example.com',
          avatar_url: null,
        });
      });

      const env = makeEnv({ userDbStub });
      const req = new Request('https://cloudssh.local/api/servers', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'user@example.com' },
      });

      const user = await getAuthenticatedUser(req, env);
      expect(user).not.toBeNull();
      expect(user?.username).toBe('user@example.com');
      expect(user?.email).toBe('user@example.com');
      expect(user?.github_id).toBe(CF_ACCESS_USER_GITHUB_ID);
      expect(requestedPath).toBe('/internal/access-user');
      expect(requestedBody).toEqual({ email: 'user@example.com' });
    });

    it('returns null if request has no access email header in cf_access mode', async () => {
      const env = makeEnv({ CF_ACCESS: 'true' });
      const req = new Request('https://cloudssh.local/api/servers');
      const user = await getAuthenticatedUser(req, env);
      expect(user).toBeNull();
    });
  });

  describe('handleLogout under CF Access', () => {
    it('returns logoutUrl pointing to /cdn-cgi/access/logout', async () => {
      const env = makeEnv();
      const req = new Request('https://cloudssh.local/api/auth/logout', {
        method: 'POST',
        headers: { 'Cf-Access-Authenticated-User-Email': 'user@example.com' },
      });

      const res = await handleLogout(req, env);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.authMode).toBe('cf_access');
      expect(data.logoutUrl).toBe('/cdn-cgi/access/logout');
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
    });
  });

  describe('Worker integration: /api/config and /api/auth/me', () => {
    it('returns cf_access authMode and email in /api/config', async () => {
      const env = makeEnv();
      const req = new Request('https://cloudssh.local/api/config', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'alice@example.com' },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.authMode).toBe('cf_access');
      expect(data.cfAccessEmail).toBe('alice@example.com');
      expect(data.githubAuthEnabled).toBe(false);
      expect(data.githubAuthRequired).toBe(true);
    });

    it('returns user info in /api/auth/me for CF Access requests', async () => {
      const userDbStub = makeDOStub(async () =>
        Response.json({
          id: 1,
          github_id: CF_ACCESS_USER_GITHUB_ID,
          username: 'bob@example.com',
          avatar_url: null,
        })
      );
      const env = makeEnv({ userDbStub });
      const req = new Request('https://cloudssh.local/api/auth/me', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'bob@example.com' },
      });

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as UserInfo;
      expect(data.username).toBe('bob@example.com');
      expect(data.email).toBe('bob@example.com');
    });
  });

  describe('UserDBDO: /internal/access-user', () => {
    it('creates new user with github_id = -2 and returns user row', async () => {
      const sql = new FakeAccessSql();
      const userDb = new UserDBDO(
        { storage: { sql } } as never,
        {} as never
      );

      const res = await userDb.fetch(
        new Request('http://internal/internal/access-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'newUser@example.com' }),
        })
      );

      expect(res.status).toBe(200);
      const user = (await res.json()) as UserInfo;
      expect(user.id).toBe(1);
      expect(user.github_id).toBe(CF_ACCESS_USER_GITHUB_ID);
      expect(user.username).toBe('newuser@example.com');
      expect(sql.users.length).toBe(1);
    });

    it('returns existing user idempotently on repeat requests', async () => {
      const sql = new FakeAccessSql();
      const userDb = new UserDBDO(
        { storage: { sql } } as never,
        {} as never
      );

      await userDb.fetch(
        new Request('http://internal/internal/access-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'alice@example.com' }),
        })
      );
      expect(sql.users.length).toBe(1);

      const res2 = await userDb.fetch(
        new Request('http://internal/internal/access-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'Alice@example.com' }),
        })
      );
      expect(res2.status).toBe(200);
      const user2 = (await res2.json()) as UserInfo;
      expect(user2.id).toBe(1);
      expect(sql.users.length).toBe(1);
    });

    it('returns 400 for missing or invalid email', async () => {
      const sql = new FakeAccessSql();
      const userDb = new UserDBDO(
        { storage: { sql } } as never,
        {} as never
      );

      const res = await userDb.fetch(
        new Request('http://internal/internal/access-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'invalid-email' }),
        })
      );
      expect(res.status).toBe(400);
    });
  });
});
