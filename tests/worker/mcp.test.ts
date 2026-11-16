import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpStore } from '../../src/worker/mcp-store';
import { handleMcp } from '../../src/worker/mcp';
import { initializeAccessIdentity } from '../../src/worker/auth';
import { authenticateMcp } from '../../src/worker/mcp-auth';
import { mcpTokenRoute, parseMcpTokenInput, readMcpJson } from '../../src/mcp-schema';
import type { Env } from '../../src/types';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE servers (id INTEGER PRIMARY KEY, user_id INTEGER); INSERT INTO servers VALUES(1,7),(2,8)');
  const sql = { exec(query: string, ...params: unknown[]) {
    const statement = db.prepare(query);
    return { toArray: () => statement.all(...params as never[]) as Record<string, unknown>[] };
  } };
  // DO SQL executes eagerly; sqlite statements do not.
  const eager = { exec(query: string, ...params: unknown[]) {
    const result = sql.exec(query, ...params).toArray(); return { toArray: () => result };
  } };
  const store = new McpStore(eager);
  const execute = vi.fn(async () => Response.json({ stdout: 'ok', stderr: '', exitCode: 0 }));
  const internal = vi.fn(async (request: Request) => {
    const body = await request.json() as any;
    const principal = await store.verify(body.token, body.modeTag);
    if (!principal) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json(body.action === 'servers' ? [{ id: 1, name: 'test' }] : principal);
  });
  const env = { GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test',
    USER_DB: { idFromName: (name: string) => name, get: () => ({ fetch: internal }) },
    MCP_EXECUTION: { idFromName: (name: string) => name, get: () => ({ fetch: execute }) },
  } as unknown as Env;
  return { db, store, env, execute, internal };
}
const input = { name: 'Claude Code', serverIds: [1], scopes: ['read', 'context'], days: 30 };
afterEach(() => vi.useRealTimers());

describe('personal MCP authorization storage', () => {
  it('stores only a digest; isolates owner, route and auth mode; supports expiry and revocation', async () => {
    const { store, db } = fixture();
    const issued = await store.create(7, '42', 'github', input);
    expect(mcpTokenRoute(issued.token)).toBe('42');
    expect(JSON.stringify(db.prepare('SELECT * FROM mcp_tokens').all())).not.toContain(issued.token);
    expect((await store.verify(issued.token, 'github'))?.userId).toBe(7);
    expect(await store.verify(issued.token.replace('mcp_42:', 'mcp_43:'), 'github')).toBeNull();
    expect(await store.verify(issued.token, 'cf_access')).toBeNull();
    expect(store.list(8)).toEqual([]);
    expect(JSON.stringify(store.list(7))).not.toContain('token_hash');
    store.revoke(issued.id, 8);
    expect(await store.verify(issued.token, 'github')).not.toBeNull();
    store.revoke(issued.id, 7);
    expect(await store.verify(issued.token, 'github')).toBeNull();
    const expired = await store.create(7, '-1', 'password:generation1', input);
    expect(await store.verify(expired.token, 'password:generation2')).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt);
    expect(await store.verify(expired.token, 'password:generation1')).toBeNull();
    vi.restoreAllMocks(); db.close();
  });
  it('rejects cross-owner servers, empty grants, oversized configuration and excessive tokens', async () => {
    const { store, db } = fixture();
    await expect(store.create(7, '42', 'github', { ...input, serverIds: [2] })).rejects.toThrow();
    for (const bad of [{ ...input, scopes: ['admin'] }, { ...input, days: 0 }, { ...input, serverIds: [] }])
      expect(() => parseMcpTokenInput(bad)).toThrow();
    for (let i = 0; i < 20; i++) await store.create(7, '42', 'github', input);
    await expect(store.create(7, '42', 'github', input)).rejects.toThrow('token_limit'); db.close();
  });
  it('limits valid requests in one authoritative window', async () => {
    const { store, db } = fixture();
    const issued = await store.create(7, '42', 'github', input);
    for (let i = 0; i < 120; i++) expect(store.consumeRequest(issued.id)).toBe(true);
    expect(store.consumeRequest(issued.id)).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    expect(store.consumeRequest(issued.id)).toBe(true);
    expect(store.consumeRequest('missing')).toBe(false);
    vi.restoreAllMocks(); db.close();
  });
  it('expires activity and never regresses a completed row to running', () => {
    const { store, db } = fixture();
    const item = { id: 'op', client: 'Claude Code', serverId: 1, tool: 'ssh_exec', status: 'success' as const,
      startedAt: Date.now(), finishedAt: Date.now() };
    store.record(7, item);
    store.record(7, { ...item, status: 'running', finishedAt: null });
    expect(store.activity(7)[0].status).toBe('success');
    expect(store.cleanup()).toBe(item.startedAt + 86_400_000);
    vi.spyOn(Date, 'now').mockReturnValue(item.startedAt + 86_400_000);
    expect(store.cleanup()).toBeNull();
    expect(store.activity(7)).toEqual([]);
    vi.restoreAllMocks(); db.close();
  });
  it('bounds activity and does not persist payloads; stale running entries become unknown', () => {
    const { store, db } = fixture();
    for (let i = 0; i < 105; i++) store.record(7, { id: String(i), client: 'Cursor', serverId: 1,
      tool: 'ssh_exec', status: 'running', startedAt: Date.now() - 180_000 + i, finishedAt: null });
    expect(store.activity(7)).toHaveLength(100);
    expect(store.activity(7)[0].status).toBe('unknown');
    expect(store.activity(8)).toEqual([]); db.close();
  });
});

describe('stateless Streamable HTTP with real MCP client', () => {
  it('initializes, lists authorized tools, calls tools and refuses unauthorized servers with no execution', async () => {
    const { store, env, execute, db } = fixture();
    const issued = await store.create(7, '42', 'github', input);
    const transport = new StreamableHTTPClientTransport(new URL('https://cloudssh.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
      fetch: async (url, init) => handleMcp(new Request(url as string, init), env),
    });
    const client = new Client({ name: 'regression', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(['server_list', 'sftp_list', 'sftp_read', 'session_output']);
    expect((await client.callTool({ name: 'server_list', arguments: {} })).isError).toBe(false);
    expect((await client.callTool({ name: 'sftp_read', arguments: { server_id: 2, path: '/etc/test' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'sftp_read', arguments: { server_id: 1, path: 'relative' } })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect((await client.callTool({ name: 'sftp_read', arguments: { server_id: 1, path: '/etc/test' } })).isError).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    store.revoke(issued.id, 7);
    await expect(client.listTools()).rejects.toThrow();
    await client.close(); db.close();
  });
  it('requires its own bearer token, rejects browser cross-origin requests and mode changes, permits CLI without Origin', async () => {
    const { store, env, db } = fixture();
    const issued = await store.create(7, '42', 'github', input);
    const request = (headers: Record<string, string>) => new Request('https://cloudssh.test/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await handleMcp(request({ Cookie: 'session=fake' }), env)).status).toBe(401);
    expect((await handleMcp(request({ Authorization: `Bearer ${issued.token}`, Origin: 'https://evil.test' }), env)).status).toBe(403);
    expect((await handleMcp(request({ Authorization: `Bearer ${issued.token}` }), { ...env, GITHUB_ALLOWED_USER_IDS: '43' })).status).toBe(401);
    expect((await handleMcp(request({ Authorization: `Bearer ${issued.token}` }), { ...env, ADMIN_PASSWORD_HASH: 'invalid' })).status).toBe(401);
    expect((await handleMcp(new Request('https://cloudssh.test/mcp', { headers: { Authorization: `Bearer ${issued.token}` } }), env)).status).toBe(405);
    db.close();
  });
  it('requires verified runtime Access admission even for personal tokens; never trusts email headers', async () => {
    const { store, env, db } = fixture();
    const route = `cf-${'a'.repeat(32)}`;
    const issued = await store.create(7, route, 'cf_access', input);
    const accessEnv = { ...env, CF_ACCESS: 'true' };
    const request = () => new Request('https://cloudssh.test/mcp', { method: 'POST',
      headers: { Authorization: `Bearer ${issued.token}`, 'Cf-Access-Authenticated-User-Email': 'spoofed@example.com' } });
    expect(await authenticateMcp(request(), accessEnv)).toBeNull();
    const verified = request();
    await initializeAccessIdentity(verified, { access: { getIdentity: async () => ({ user_uuid: 'service-identity' }) } } as never);
    expect(await authenticateMcp(verified, accessEnv)).toMatchObject({ principal: { routeKey: route } });
    const failed = request();
    await initializeAccessIdentity(failed, { access: { getIdentity: async () => { throw new Error('unavailable'); } } } as never);
    expect(await authenticateMcp(failed, accessEnv)).toBeNull();
    db.close();
  });
  it('rejects oversized request bodies even without Content-Length', async () => {
    const request = new Request('https://test/mcp', { method: 'POST', body: 'a'.repeat(512 * 1024 + 1) });
    await expect(readMcpJson(request)).rejects.toThrow('body_too_large');
  });
});
