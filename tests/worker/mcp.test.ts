import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpStore } from '../../src/worker/mcp-store';
import { handleMcp } from '../../src/worker/mcp';
import { initializeAccessIdentity } from '../../src/worker/auth';
import { authenticateMcp } from '../../src/worker/mcp-auth';
import worker from '../../src/worker/index';
import { mcpTokenRoute, parseMcpConfigInput, readMcpJson } from '../../src/mcp-schema';
import type { Env } from '../../src/types';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE servers (id INTEGER PRIMARY KEY, user_id INTEGER); INSERT INTO servers VALUES(1,7),(2,8),(3,7)');
  const sql = { exec(query: string, ...params: unknown[]) {
    const result = db.prepare(query).all(...params as never[]) as Record<string, unknown>[];
    return { toArray: () => result };
  } };
  const key = crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
  const encrypt = async (plain: string) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key, new TextEncoder().encode(plain)));
    return Buffer.from(iv).toString('base64') + ':' + Buffer.from(encrypted).toString('base64');
  };
  const decrypt = async (value: string) => {
    const [iv, data] = value.split(':');
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, await key, Buffer.from(data, 'base64')));
  };
  const store = new McpStore(sql, encrypt, decrypt);
  const execute = vi.fn(async () => Response.json({ stdout: 'ok', stderr: '', exitCode: 0 }));
  const internal = vi.fn(async (request: Request) => {
    const body = await request.json() as any;
    const principal = await store.verify(body.token, body.modeTag);
    if (!principal) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (body.action === 'authorize' && !store.consumeRequest(principal.id)) return Response.json({ error: 'rate_limited' }, { status: 429 });
    return Response.json(body.action === 'servers' ? principal.serverIds.map(id => ({ id, name: 'test' })) : principal);
  });
  const env = { GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test',
    USER_DB: { idFromName: (name: string) => name, get: () => ({ fetch: internal }) },
    MCP_EXECUTION: { idFromName: (name: string) => name, get: () => ({ fetch: execute }) },
  } as unknown as Env;
  const create = async (input: unknown = { grants: [{ serverId: 1, scopes: ['read', 'context'] }] }, route = '42', mode = 'github') => {
    const info = await store.create(7, route, mode, input);
    return { info, ...(await store.credentials(7, route, mode)) };
  };
  return { db, store, env, execute, create, internal };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const input = { grants: [{ serverId: 1, scopes: ['read', 'context'] }] };

describe('singleton encrypted MCP configuration', () => {
  it('generates once, encrypts recoverable credentials and preserves the same token indefinitely', async () => {
    const { store, db, create } = fixture();
    const first = await create();
    const again = await create();
    expect(again.token).toBe(first.token);
    expect(again.info.id).toBe(first.info.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_configs').get()!.n).toBe(1);
    expect(JSON.stringify(db.prepare('SELECT * FROM mcp_configs').all())).not.toContain(first.token);
    expect(JSON.stringify(store.get(7, '42', 'github'))).not.toContain(first.token);
    expect(mcpTokenRoute(first.token)).toBe('42');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 365 * 86400_000);
    expect(await store.verify(first.token, 'github')).not.toBeNull();
    expect(await store.verify(first.token, 'cf_access')).toBeNull();
    expect(() => store.get(7, '43', 'github')).toThrow('invalid_identity');
    expect(store.get(8, '43', 'github').configured).toBe(false);
    db.close();
  });
  it('concurrent first generation is idempotent and does not replace grants or token', async () => {
    const { create, db } = fixture();
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.token).toBe(b.token);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_configs').get()!.n).toBe(1);
    db.close();
  });
  it('updates individual server grants and allows removing all access without rotating the token', async () => {
    const { create, store, db } = fixture();
    const { token } = await create();
    await store.update(7, '42', 'github', { grants: [{ serverId: 1, scopes: ['read'] }, { serverId: 3, scopes: ['exec'] }] });
    expect((await store.verify(token, 'github'))!.grants).toEqual([{ serverId: 1, scopes: ['read'] }, { serverId: 3, scopes: ['exec'] }]);
    await store.update(7, '42', 'github', { grants: [] });
    expect((await store.verify(token, 'github'))!.serverIds).toEqual([]);
    expect((await store.credentials(7, '42', 'github')).token).toBe(token);
    db.close();
  });
  it('requires explicitly owned servers and rejects duplicate or malformed grants', async () => {
    const { store, db } = fixture();
    await expect(store.create(7, '42', 'github', { grants: [{ serverId: 2, scopes: ['read'] }] })).rejects.toThrow('server_not_found');
    for (const bad of [{ grants: [{ serverId: 1, scopes: ['admin'] }] }, { grants: [{ serverId: 1, scopes: [] }] },
      { grants: [{ serverId: 1, scopes: ['read'] }, { serverId: 1, scopes: ['exec'] }] }, { grants: Array(101).fill({ serverId: 1, scopes: ['read'] }) }])
      expect(() => parseMcpConfigInput(bad)).toThrow();
    db.close();
  });
  it('encrypts Access credentials and can update them without changing the personal token', async () => {
    const { create, store, db } = fixture();
    const route = `cf-${'a'.repeat(32)}`;
    const first = await create({ ...input, access: { clientId: 'service.access', clientSecret: 'ACCESS-SECRET' } }, route, 'cf_access');
    expect(JSON.stringify(db.prepare('SELECT * FROM mcp_configs').all())).not.toContain('ACCESS-SECRET');
    expect((await store.credentials(7, route, 'cf_access')).access!.clientSecret).toBe('ACCESS-SECRET');
    await store.update(7, route, 'cf_access', { ...input, access: { clientId: 'new.access', clientSecret: 'NEW-SECRET' } });
    expect(await store.credentials(7, route, 'cf_access')).toEqual({ token: first.token, access: { clientId: 'new.access', clientSecret: 'NEW-SECRET' } });
    db.close();
  });
  it('never accepts legacy digest-only tokens and removes legacy rows on explicit first generation', async () => {
    const { create, store, db } = fixture();
    db.prepare(`INSERT INTO mcp_tokens(id,token_hash,user_id,name,server_ids,scopes,route_key,mode_tag,expires_at,created_at)
      VALUES('old','digest',7,'old','[1]','["exec"]','42','github',9999999999999,1)`).run();
    expect(store.get(7, '42', 'github').legacy).toBe(true);
    expect(await store.verify(`mcp_42:${'a'.repeat(64)}`, 'github')).toBeNull();
    await create();
    expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens').get()!.n).toBe(0);
    db.close();
  });
  it('password rotation rejects the old binding until the owner explicitly copies the same saved token', async () => {
    const { create, store, db } = fixture();
    const first = await create(input, '-1', 'password:one');
    expect(await store.verify(first.token, 'password:two')).toBeNull();
    store.get(7, '-1', 'password:two');
    expect(await store.verify(first.token, 'password:two')).toBeNull();
    expect((await store.credentials(7, '-1', 'password:two')).token).toBe(first.token);
    expect(await store.verify(first.token, 'password:two')).not.toBeNull();
    db.close();
  });
  it('keeps request budgets and bounded expiring activity, never regressing completed rows', async () => {
    const { create, store, db } = fixture();
    const { info } = await create();
    for (let i = 0; i < 120; i++) expect(store.consumeRequest(info.id!)).toBe(true);
    expect(store.consumeRequest(info.id!)).toBe(false);
    for (let i = 0; i < 105; i++) store.record(7, { id: String(i), client: 'MCP', serverId: 1, tool: 'ssh_exec', status: 'success', startedAt: Date.now() + i, finishedAt: Date.now() });
    store.record(7, { id: '104', client: 'MCP', serverId: 1, tool: 'ssh_exec', status: 'running', startedAt: Date.now(), finishedAt: null });
    expect(store.activity(7)).toHaveLength(100); expect(store.activity(7)[0].status).toBe('success');
    expect(store.activity(8)).toEqual([]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86401_000);
    expect(store.cleanup()).toBeNull(); expect(store.activity(7)).toEqual([]);
    db.close();
  });
});

describe('real MCP client with live per-server authorization', () => {
  it('lists the union of tools but enforces each server grant independently and observes edits', async () => {
    const { store, env, execute, create, db } = fixture();
    const { token } = await create({ grants: [{ serverId: 1, scopes: ['read', 'context'] }, { serverId: 3, scopes: ['exec'] }] });
    const transport = new StreamableHTTPClientTransport(new URL('https://cloudssh.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, init) => handleMcp(new Request(url as string, init), env),
    });
    const client = new Client({ name: 'regression', version: '1.0.0' }); await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['server_list', 'ssh_exec', 'sftp_list', 'sftp_read', 'session_output']);
    expect((await client.callTool({ name: 'ssh_exec', arguments: { server_id: 1, command: 'pwd' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'sftp_read', arguments: { server_id: 3, path: '/file' } })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect((await client.callTool({ name: 'ssh_exec', arguments: { server_id: 3, command: 'pwd' } })).isError).toBe(false);
    await store.update(7, '42', 'github', { grants: [] });
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['server_list']);
    await client.close(); db.close();
  });
  it('requires Bearer, rejects cross-origin, mode changes and disallowed identities', async () => {
    const { create, env, db } = fixture(); const { token } = await create();
    const req = (headers: Record<string, string>) => new Request('https://cloudssh.test/mcp', { method: 'POST', headers, body: '{}' });
    expect((await handleMcp(req({ Cookie: 'session=fake' }), env)).status).toBe(401);
    expect((await handleMcp(req({ Authorization: `Bearer ${token}`, Origin: 'https://evil.test' }), env)).status).toBe(403);
    expect((await handleMcp(req({ Authorization: `Bearer ${token}` }), { ...env, GITHUB_ALLOWED_USER_IDS: '43' })).status).toBe(401);
    expect((await handleMcp(req({ Authorization: `Bearer ${token}` }), { ...env, ADMIN_PASSWORD_HASH: 'invalid' })).status).toBe(401);
    db.close();
  });
  it('still requires runtime-verified Access admission rather than email headers', async () => {
    const { create, env, db } = fixture(); const route = `cf-${'a'.repeat(32)}`;
    const { token } = await create({ ...input, access: { clientId: 'id', clientSecret: 'secret' } }, route, 'cf_access');
    const req = () => new Request('https://cloudssh.test/mcp', { headers: { Authorization: `Bearer ${token}`, 'Cf-Access-Authenticated-User-Email': 'spoof@example.com' } });
    expect(await authenticateMcp(req(), { ...env, CF_ACCESS: 'true' })).toBeNull();
    const verified = req(); await initializeAccessIdentity(verified, { access: { aud: 'test-app', getIdentity: async () => ({ user_uuid: 'service' }) } });
    expect(await authenticateMcp(verified, { ...env, CF_ACCESS: 'true' })).toMatchObject({ principal: { routeKey: route } }); db.close();
  });
  it.each(['undefined', 'throws', 'never'])('supports native Access machine admission with no user profile (%s) through the Worker and SDK', async result => {
    const { create, env, store, internal, execute, db } = fixture();
    const route = `cf-${'a'.repeat(32)}`;
    const { token } = await create({ ...input, access: { clientId: 'service.access', clientSecret: 'private-access-secret' } }, route, 'cf_access');
    const getIdentity = vi.fn(async () => {
      if (result === 'throws') throw new Error('private-identity-error');
      if (result === 'never') return new Promise<CloudflareAccessIdentity>(() => {});
      return undefined;
    });
    const ctx = { access: { aud: 'test-app', getIdentity } };
    const client = new Client({ name: 'access-machine-regression', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://cloudssh.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'CF-Access-Client-Id': 'service.access', 'CF-Access-Client-Secret': 'private-access-secret' } },
      fetch: async (url, init) => worker.fetch(new Request(url as string, init), { ...env, REQUIRE_AUTH: 'true' }, ctx),
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t => t.name)).toContain('server_list');
      const servers = await client.callTool({ name: 'server_list', arguments: {} });
      expect(servers.isError).not.toBe(true);
      expect(JSON.parse((servers.content as Array<{ text: string }>)[0].text)).toEqual([{ id: 1, name: 'test' }]);
      expect((await client.callTool({ name: 'sftp_read', arguments: { server_id: 2, path: '/file' } })).isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      await store.update(7, route, 'cf_access', { grants: [] });
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['server_list']);
      expect((await store.credentials(7, route, 'cf_access')).token).toBe(token);
      expect(internal).toHaveBeenCalled();
      expect(getIdentity).not.toHaveBeenCalled();
    } finally {
      await client.close(); db.close();
    }
  });

  it('native Access admission still rejects bad Bearers, account modes and absent native context', async () => {
    const { create, env, internal, db } = fixture(); const route = `cf-${'a'.repeat(32)}`;
    const { token } = await create({ ...input, access: { clientId: 'id', clientSecret: 'secret' } }, route, 'cf_access');
    const ctx = { access: { aud: 'test-app', getIdentity: vi.fn(async () => undefined) } };
    const req = (bearer: string) => new Request('https://cloudssh.test/mcp', { method: 'POST', body: '{}', headers: {
      Authorization: `Bearer ${bearer}`, 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret',
      'Cf-Access-Jwt-Assertion': 'forged-jwt', 'Cf-Access-Authenticated-User-Email': 'spoof@example.com',
    } });
    try {
      const changed = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
      for (const bad of ['malformed', changed, `mcp_42:${'a'.repeat(64)}`]) {
        const res = await worker.fetch(req(bad), env, ctx);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
      }
      internal.mockClear();
      for (const overrides of [{ CF_ACCESS: 'true' }, { CF_ACCESS: 'true', REQUIRE_AUTH: 'true' }, {}]) {
        expect((await worker.fetch(req(token), { ...env, ...overrides })).status).toBe(401);
      }
      expect(internal).not.toHaveBeenCalled();
      for (const aud of ['', ' ', 'aud\n', undefined]) {
        expect((await worker.fetch(req(token), env, { access: { aud, getIdentity: ctx.access.getIdentity } } as never)).status).toBe(401);
      }
      expect(internal).not.toHaveBeenCalled();
      expect(ctx.access.getIdentity).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('rejects oversized bodies without Content-Length', async () => {
    await expect(readMcpJson(new Request('https://test/mcp', { method: 'POST', body: 'a'.repeat(512 * 1024 + 1) }))).rejects.toThrow('body_too_large');
  });
});
