import { describe, expect, it, vi } from 'vitest';
import type { Env, UserInfo } from '../../src/types';
import {
  CF_ACCESS_USER_GITHUB_ID,
  initializeAccessIdentity,
  isConnectTokenRouteAllowed,
  connectTokenRouteKey,
  getAccessUserRouteKey,
  getAuthenticatedUser,
  isSshIdentityAllowed,
  userDbRouteKey,
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

function accessContext(email = 'user@example.com'): Pick<ExecutionContext, 'access'> {
  return { access: { aud: 'test-app', getIdentity: async () => ({ email }) as CloudflareAccessIdentity } };
}

describe('Cloudflare Access (Zero Trust) Authentication', () => {
  describe('getCFAccessEmail', () => {
    it('trusts the runtime identity, never a conflicting request header', async () => {
      const req = new Request('https://cloudssh.local/', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'attacker@example.com' },
      });
      expect(getCFAccessEmail(req)).toBeNull();
      await initializeAccessIdentity(req, accessContext('User@Example.COM'));
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
    it('generates a stable, case-insensitive route key without embedding the email', async () => {
      const key1 = await getAccessUserRouteKey('Alice@Example.COM');
      const key2 = await getAccessUserRouteKey('alice@example.com');
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^cf-[0-9a-f]{32}$/);
      expect(key1.includes(':')).toBe(false);
    });

    it('does not collide emails that only differ inside the same length', async () => {
      const keyA = await getAccessUserRouteKey('alice@example.com');
      const keyB = await getAccessUserRouteKey('alica@example.com');
      expect(keyA).not.toBe(keyB);
      expect('alice@example.com'.length).toBe('alica@example.com'.length);
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

    it('detects cf_access only from a verified runtime context', async () => {
      const req = new Request('https://cloudssh.local/', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'user@example.com' },
      });
      expect(resolveAuthMode(baseEnv, req)).toBe('anonymous');
      await initializeAccessIdentity(req, accessContext());
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

      await initializeAccessIdentity(req, accessContext());
      const user = await getAuthenticatedUser(req, env);
      expect(user).not.toBeNull();
      expect(user?.username).toBe('user@example.com');
      expect(user?.email).toBe('user@example.com');
      expect(user?.github_id).toBe(CF_ACCESS_USER_GITHUB_ID);
      expect(requestedPath).toBe('/internal/access-user');
      expect(requestedBody).toEqual({ email: 'user@example.com' });
    });

    it('routes later API calls to the email database instead of github_id -2', async () => {
      const names: string[] = [];
      const env = makeEnv();
      (env.USER_DB as any).idFromName = (name: string) => {
        names.push(name);
        return name;
      };
      (env.USER_DB as any).get = () => ({
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (path === '/internal/access-user') {
            return Response.json({
              id: 7,
              github_id: CF_ACCESS_USER_GITHUB_ID,
              username: 'user@example.com',
              avatar_url: null,
            });
          }
          if (path === '/internal/servers' && req.method === 'POST') {
            const body = (await req.json()) as { user_id?: number };
            return Response.json({ id: 1, user_id: body.user_id }, { status: 201 });
          }
          return new Response(`unexpected ${path}`, { status: 500 });
        },
      });

      const res = await worker.fetch(
        new Request('https://cloudssh.local/api/servers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'user@example.com',
          },
          body: JSON.stringify({
            name: 'n',
            host: 'ssh.example.com',
            port: 22,
            username: 'root',
            auth_method: 'publickey',
            cf_ssh_ca_team: 'my-team',
          }),
        }),
        env,
        accessContext()
      );

      expect(res.status).toBe(201);
      const route = await getAccessUserRouteKey('user@example.com');
      expect(names).toContain(route);
      expect(names).not.toContain('-2');
      expect(await userDbRouteKey({
        id: 7,
        github_id: CF_ACCESS_USER_GITHUB_ID,
        username: 'user@example.com',
        avatar_url: null,
        email: 'user@example.com',
      })).toBe(route);
      const token = `${route}:${crypto.randomUUID()}`;
      expect(connectTokenRouteKey(token)).toBe(route);
      expect(connectTokenRouteKey('-2:abc')).toBeNull();
      expect(connectTokenRouteKey('cf:userexamplecom-0123456789abcdef:abc')).toBeNull();
      expect(
        isSshIdentityAllowed(
          { GITHUB_ALLOWED_USER_IDS: '12345' } as Env,
          CF_ACCESS_USER_GITHUB_ID
        )
      ).toBe(true);
      expect(isSshIdentityAllowed({ GITHUB_ALLOWED_USER_IDS: '12345' } as Env, 999)).toBe(false);
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

      await initializeAccessIdentity(req, accessContext());
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

      const res = await worker.fetch(req, env, accessContext('alice@example.com'));
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

      const res = await worker.fetch(req, env, accessContext('bob@example.com'));
      expect(res.status).toBe(200);
      const data = (await res.json()) as UserInfo;
      expect(data.username).toBe('bob@example.com');
      expect(data.email).toBe('bob@example.com');
    });
  });

  describe('Access boundary regressions', () => {
    it('does not authenticate a forged header against a GitHub instance', async () => {
      const stub = makeDOStub(() => Response.json({ id: 1, github_id: -2 }));
      const env = makeEnv({ GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', userDbStub: stub });
      const res = await worker.fetch(new Request('https://cloudssh.local/api/servers', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' },
      }), env);
      expect(res.status).toBe(401);
      expect(stub.fetch).not.toHaveBeenCalled();
    });

    it('keeps Access mode on lookup failure and rejects instead of falling back to GitHub', async () => {
      const env = makeEnv({ GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret' });
      const ctx = { access: { aud: 'app', getIdentity: async () => { throw new Error('unavailable'); } } };
      const req = new Request('https://cloudssh.local/api/auth/me', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' },
      });
      const res = await worker.fetch(req, env, ctx);
      expect(res.status).toBe(401);
      expect(resolveAuthMode(env, req)).toBe('cf_access');
      expect(getCFAccessEmail(req)).toBeNull();
    });

    it('bounds identity lookup and does not accept service identities without email', async () => {
      vi.useFakeTimers();
      try {
        const req = new Request('https://cloudssh.local/');
        const pending = initializeAccessIdentity(req, { access: { aud: 'app', getIdentity: () => new Promise(() => {}) } });
        await vi.advanceTimersByTimeAsync(4000);
        await pending;
        expect(getCFAccessEmail(req)).toBeNull();
        expect(resolveAuthMode({} as Env, req)).toBe('cf_access');
        const serviceReq = new Request('https://cloudssh.local/');
        await initializeAccessIdentity(serviceReq, { access: { aud: 'app', getIdentity: async () => undefined } });
        expect(getCFAccessEmail(serviceReq)).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it('disables both OAuth endpoints under runtime-detected Access', async () => {
      const env = makeEnv({ GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret' });
      for (const path of ['/api/auth/github', '/api/auth/callback?code=legacy']) {
        const res = await worker.fetch(new Request(`https://cloudssh.local${path}`), env, accessContext());
        expect(res.status).toBe(501);
      }
    });

    it('rejects a pending Access token after switching away from Access, before consumption', async () => {
      const stub = makeDOStub(() => Response.json({ githubId: '-2' }));
      const route = await getAccessUserRouteKey('user@example.com');
      const env = makeEnv({ GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', userDbStub: stub });
      const res = await worker.fetch(new Request(`https://cloudssh.local/api/ssh?token=${route}:secret`, {
        headers: { Origin: 'https://cloudssh.local', Upgrade: 'websocket' },
      }), env);
      expect(res.status).toBe(403);
      expect(stub.fetch).not.toHaveBeenCalled();
    });

    it('does not consume another Access account token', async () => {
      const route = await getAccessUserRouteKey('bob@example.com');
      const stub = makeDOStub(req => {
        expect(new URL(req.url).pathname).toBe('/internal/access-user');
        return Response.json({ id: 1, github_id: -2, username: 'alice@example.com' });
      });
      const res = await worker.fetch(new Request(`https://cloudssh.local/api/ssh?token=${route}:secret`, {
        headers: { Origin: 'https://cloudssh.local', Upgrade: 'websocket' },
      }), makeEnv({ userDbStub: stub }), accessContext('alice@example.com'));
      expect(res.status).toBe(403);
      expect(stub.fetch).toHaveBeenCalledTimes(1);
    });

    it('fails closed for direct and resume SSH when Access is required but not verified', async () => {
      for (const query of ['', '?session=s&resume_token=r']) {
        const res = await worker.fetch(new Request(`https://cloudssh.local/api/ssh${query}`, {
          headers: { Origin: 'https://cloudssh.local', Upgrade: 'websocket' },
        }), makeEnv({ CF_ACCESS: 'true' }));
        expect(res.status).toBe(401);
      }
    });

    it.each(['false', 'true'])('never exposes unexpected server errors (DEBUG_MODE=%s)', async debug => {
      const secret = 'internal-token-and-schema';
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const env = makeEnv({ DEBUG_MODE: debug, userDbStub: makeDOStub(() => { throw new Error(secret); }) });
        const res = await worker.fetch(new Request('https://cloudssh.local/api/servers'), env, accessContext());
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Internal Server Error' });
        expect(log.mock.calls.flat().join(' ')).not.toContain(secret);
      } finally { log.mockRestore(); }
    });

    it('gates CA signing on verified Access identity, not JWT/email headers alone', async () => {
      const req = () => new Request('https://cloudssh.local/api/cf-ssh-ca/sign', {
        method: 'POST',
        headers: { Origin: 'https://cloudssh.local', 'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'owner@example.com', 'Cf-Access-Jwt-Assertion': 'unverified' },
        body: '{}',
      });
      expect((await worker.fetch(req(), makeEnv())).status).toBe(401);
      // A trusted identity reaches the handler, which then rejects the missing public key.
      expect((await worker.fetch(req(), makeEnv(), accessContext())).status).toBe(400);
      expect((await worker.fetch(req(), makeEnv({ ADMIN_PASSWORD_HASH: 'configured' }), accessContext())).status).toBe(401);
    });

    it('distinguishes all connection-token identity families', async () => {
      const route = await getAccessUserRouteKey('alice@example.com');
      expect(isConnectTokenRouteAllowed('cf_access', route)).toBe(true);
      expect(isConnectTokenRouteAllowed('cf_access', '123')).toBe(false);
      expect(isConnectTokenRouteAllowed('password', '-1')).toBe(true);
      expect(isConnectTokenRouteAllowed('password', route)).toBe(false);
      expect(isConnectTokenRouteAllowed('github', '123')).toBe(true);
      expect(isConnectTokenRouteAllowed('github', route)).toBe(false);
      expect(isConnectTokenRouteAllowed('anonymous', '-1')).toBe(false);
      expect(connectTokenRouteKey('arbitrary:token')).toBeNull();
      expect(connectTokenRouteKey('123:token:extra')).toBeNull();
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
