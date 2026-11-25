import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { UserDBDO } from '../../src/worker/user-db';
import type { McpActivity } from '../../src/mcp-schema';

function fixture(env: Partial<Env> = {}) {
  const database = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...params: any[]) {
    let result: unknown[] = [];
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) result = database.prepare(query).all(...params);
    else if (params.length) database.prepare(query).run(...params);
    else database.exec(query);
    return { toArray: () => result };
  } };
  let alarm: number | null = null;
  const storage = { sql, getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; },
    transactionSync<T>(callback: () => T): T {
      database.exec('BEGIN');
      try { const value = callback(); database.exec('COMMIT'); return value; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  const reopen = () => new UserDBDO({ storage } as unknown as DurableObjectState, env as Env);
  const object = reopen();
  database.exec(`INSERT INTO users(id, github_id, username) VALUES (7,42,'owner'),(8,43,'other');
    INSERT INTO servers(id,user_id,name,host,port,username,credential,auth_method) VALUES
      (1,7,'target','target.example.com',22,'owner','','none'),
      (2,8,'other','other.example.com',22,'other','','none');`);
  const call = async (body: Record<string, unknown>) => object.fetch(new Request('http://internal/internal/mcp', {
    method: 'POST', body: JSON.stringify({ userId: 7, routeKey: '42', modeTag: 'github', ...body }),
  }));
  const remove = (id: number, userId = 7) => object.fetch(new Request(`http://internal/internal/servers/${id}`, {
    method: 'DELETE', body: JSON.stringify({ user_id: userId }),
  }));
  const ticket = (id: number) => object.fetch(new Request(`http://internal/internal/servers/${id}/connect`, {
    method: 'POST', body: JSON.stringify({ user_id: 7 }),
  }));
  const consume = (token: string) => object.fetch(new Request('http://internal/internal/connect-token/consume', {
    method: 'POST', body: JSON.stringify({ token }),
  }));
  return { database, object, call, storage, remove, ticket, consume, reopen, alarm: () => alarm };
}
describe('MCP saved configuration and shared Alarm integration', () => {
  it('upgrades legacy activity rows and only stores and displays whitelisted failure reasons', async () => {
    const f = fixture();
    const now = Date.now();
    f.database.exec('ALTER TABLE mcp_activity DROP COLUMN failure_reason');
    f.database.prepare(`INSERT INTO mcp_activity(id,user_id,client,server_id,tool,status,started_at)
      VALUES('legacy',7,'test',1,'ssh_exec','error',?)`).run(now);
    const upgraded = f.reopen();
    f.reopen(); // schema initialization is idempotent
    const call = (body: Record<string, unknown>) => upgraded.fetch(new Request('http://internal/internal/mcp', {
      method: 'POST', body: JSON.stringify({ userId: 7, ...body }),
    }));
    const base = { id: 'current', client: 'test', serverId: 1, tool: 'ssh_exec', startedAt: now + 1 };
    await call({ action: 'record', activity: { ...base, status: 'running', finishedAt: null } });
    await call({ action: 'record', activity: { ...base, status: 'error', finishedAt: now + 2, failureReason: 'exec_rejected' } });
    await call({ action: 'record', activity: { ...base, id: 'untrusted', status: 'unknown', finishedAt: now + 2, failureReason: 'private command' } });
    expect(f.database.prepare('SELECT failure_reason FROM mcp_activity WHERE id = ?').get('untrusted')?.failure_reason).toBeNull();
    // Even invalid DB values from past versions cannot be echoed as diagnostic metadata.
    f.database.prepare('UPDATE mcp_activity SET failure_reason = ? WHERE id = ?').run('private log', 'untrusted');
    const items = await (await call({ action: 'activity' })).json() as McpActivity[];
    expect(items.find(item => item.id === 'current')).toMatchObject({ status: 'error', failureReason: 'exec_rejected' });
    expect(items.find(item => item.id === 'legacy')).not.toHaveProperty('failureReason');
    expect(items.find(item => item.id === 'untrusted')).not.toHaveProperty('failureReason');
  });
  it('resolves only owned saved servers, requires existing trust, and does not issue browser tokens or reorder servers', async () => {
    const f = fixture();
    const created = await f.call({ action: 'create', input: { grants: [{ serverId: 1, scopes: ['exec'] }] } });
    expect(created.ok).toBe(true);
    const { token } = await (await f.call({ action: 'credentials' })).json() as { token: string };
    const missing = await f.call({ action: 'config', token, serverId: 1 });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: 'host_verification_required' });
    f.database.exec(`INSERT INTO known_hosts(user_id,host,port,fingerprint) VALUES(7,'target.example.com',22,'SHA256:trusted')`);
    const response = await f.call({ action: 'config', token, serverId: 1 });
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ authMethod: 'none', expectedFingerprint: 'SHA256:trusted', userDbRouteKey: '42' });
    expect((f.object as any).connectTokens.size).toBe(0);
    expect(f.database.prepare('SELECT last_connected_at FROM servers WHERE id=1').get()!.last_connected_at).toBeNull();
    expect((await f.call({ action: 'config', token, serverId: 2 })).status).toBe(403);
    f.database.exec('UPDATE servers SET jump_server_id = 2 WHERE id = 1');
    expect((await f.call({ action: 'config', token, serverId: 1 })).status).toBe(403);
    f.database.exec("UPDATE servers SET jump_server_id = NULL, cf_ssh_ca_team = 'team' WHERE id = 1");
    expect(await (await f.call({ action: 'config', token, serverId: 1 })).json()).toMatchObject({ error: 'interactive_auth_required' });
    f.database.close();
  });
  it('deletes only the target associations, including late activity and pending tickets, without rotating tokens', async () => {
    const invalidate = vi.fn(async (_request: Request) => Response.json({ success: true }));
    const idFromName = vi.fn((name: string) => name);
    const f = fixture({ MCP_EXECUTION: { idFromName, get: () => ({ fetch: invalidate }) } as never });
    const db = f.database;
    db.exec(`INSERT INTO servers(id,user_id,name,host,username,credential) VALUES(3,7,'keep','target.example.com','other','');
      INSERT INTO known_hosts(user_id,host,port,fingerprint) VALUES(7,'target.example.com',22,'SHA256:trusted');
      INSERT INTO ssh_shares(id,user_id,server_id,share_ref,expires_at,max_session_seconds,status,created_at)
        VALUES('audit',7,1,'ref',1,60,'closed',1);
      INSERT INTO server_work_logs(user_id,server_id,title,summary,created_at,updated_at) VALUES(7,1,'a','a',1,1),(7,3,'b','b',1,1);
      INSERT INTO server_knowledge(user_id,server_id,category,key,value,created_at,updated_at) VALUES(7,1,'host','a','a',1,1);
      INSERT INTO agent_memory_state(user_id,server_id) VALUES(7,1);
      INSERT INTO agent_knowledge_meta(user_id,server_id,key) VALUES(7,1,'a');
      INSERT INTO agent_pending_distillations(user_id,server_id,task_id,payload_enc,updated_at) VALUES(7,1,'old','unused',1);`);
    const keep = { serverId: 3, scopes: ['read'] }, drop = { serverId: 1, scopes: ['exec', 'context'] };
    const { id } = await (await f.call({ action: 'create', input: { grants: [drop, keep] } })).json() as { id: string };
    const { token } = await (await f.call({ action: 'credentials' })).json() as { token: string };
    await f.call({ action: 'create', userId: 8, routeKey: '43', input: { grants: [{ serverId: 2, scopes: ['exec'] }] } });
    const other = db.prepare('SELECT * FROM mcp_configs WHERE user_id=8').get();
    const binding = () => db.prepare('SELECT id,token_hash,credentials_enc,mode_tag,route_key FROM mcp_configs WHERE user_id=7').get();
    const before = binding();
    const activity = (serverId: number): McpActivity => ({ id: `op-${serverId}`, client: 'MCP', serverId, tool: 'ssh_exec',
      status: 'running', startedAt: Date.now(), finishedAt: null });
    await f.call({ action: 'record', activity: activity(1) });
    await f.call({ action: 'record', activity: activity(3) });
    const tokens = await Promise.all([1, 3].map(async (id) => (await (await f.ticket(id)).json() as { token: string }).token));
    expect(await (await f.call({ action: 'servers', token })).json()).toHaveLength(2);
    expect((await f.remove(1)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith(`mcp:42:${id}`);
    expect(invalidate.mock.calls[0][0].url).toBe('https://internal/invalidate/1');
    expect(db.prepare('SELECT grants FROM mcp_configs WHERE user_id=7').get()?.grants).toBe(JSON.stringify([keep]));
    expect(binding()).toEqual(before);
    expect(db.prepare('SELECT * FROM mcp_configs WHERE user_id=8').get()).toEqual(other);
    for (const table of ['server_work_logs', 'server_knowledge', 'agent_memory_state', 'agent_knowledge_meta', 'agent_pending_distillations']) {
      expect(db.prepare(`SELECT server_id FROM ${table} WHERE server_id=1`).all(), table).toEqual([]);
    }
    expect(db.prepare('SELECT server_id FROM server_work_logs').all()).toEqual([{ server_id: 3 }]);
    expect(db.prepare('SELECT id FROM ssh_shares').get()?.id).toBe('audit');
    expect(db.prepare('SELECT fingerprint FROM known_hosts').get()?.fingerprint).toBe('SHA256:trusted');
    await f.call({ action: 'record', activity: { ...activity(1), status: 'success', finishedAt: Date.now() } });
    expect(await (await f.call({ action: 'activity' })).json()).toEqual([expect.objectContaining({ serverId: 3 })]);
    expect(await (await f.call({ action: 'settings' })).json()).toMatchObject({ grants: [keep] });
    expect(await (await f.call({ action: 'verify', token })).json()).toMatchObject({ serverIds: [3], scopes: ['read'] });
    expect(await (await f.call({ action: 'servers', token })).json()).toEqual([expect.objectContaining({ id: 3 })]);
    expect((await f.call({ action: 'config', token, serverId: 1 })).status).toBe(403);
    expect((await f.call({ action: 'owns_server', serverId: 1 })).status).toBe(404);
    expect((await f.call({ action: 'update', input: { grants: [drop, keep] } })).status).toBe(400);
    expect((await f.consume(tokens[0])).status).toBe(404);
    expect((await f.consume(tokens[1])).status).toBe(200);
    invalidate.mockRejectedValueOnce(new Error('pool unavailable'));
    expect((await f.remove(3)).status).toBe(200);
    expect(await (await f.call({ action: 'servers', token })).json()).toEqual([]);
    expect(await (await f.call({ action: 'credentials' })).json()).toEqual({ token });
    db.close();
  });

  it('does not partially prune a forbidden, referenced, shared, or rolled-back deletion', async () => {
    const f = fixture(); const db = f.database;
    const grants = [{ serverId: 1, scopes: ['read'] }];
    await f.call({ action: 'create', input: { grants } });
    await f.call({ action: 'record', activity: { id: 'op', client: 'MCP', tool: 'sftp_read', serverId: 1,
      status: 'success', startedAt: Date.now(), finishedAt: Date.now() } });
    const { token } = await (await f.ticket(1)).json() as { token: string };
    expect((await f.remove(1, 8)).status).toBe(403);
    expect((await f.remove(88)).status).toBe(404);
    db.exec(`INSERT INTO servers(id,user_id,name,host,username,credential,jump_server_id) VALUES(3,7,'leaf','example.com','u','',1)`);
    expect((await f.remove(1)).status).toBe(409);
    db.exec(`UPDATE servers SET jump_server_id=NULL WHERE id=3;
      INSERT INTO ssh_shares(id,user_id,server_id,share_ref,expires_at,max_session_seconds,status,created_at)
        VALUES('share',7,1,'ref',1,60,'active',1)`);
    expect((await f.remove(1)).status).toBe(409);
    db.exec(`UPDATE ssh_shares SET status='closed';
      CREATE TRIGGER fail_cleanup BEFORE DELETE ON mcp_activity BEGIN SELECT RAISE(ABORT, 'unavailable'); END`);
    expect((await f.remove(1)).status).toBe(500);
    expect(db.prepare('SELECT id FROM servers WHERE id=1').get()?.id).toBe(1);
    expect(db.prepare('SELECT grants FROM mcp_configs WHERE user_id=7').get()?.grants).toBe(JSON.stringify(grants));
    expect(db.prepare('SELECT id FROM mcp_activity').get()?.id).toBe('op');
    expect((await f.consume(token)).status).toBe(200);
    db.close();
  });

  it('repairs historical dangling IDs on reconstruction, including legacy lists, without changing valid bindings', async () => {
    const f = fixture(); const db = f.database;
    await f.call({ action: 'create', input: { grants: [{ serverId: 1, scopes: ['read'] }] } });
    const { token } = await (await f.call({ action: 'credentials' })).json() as { token: string };
    db.exec(`UPDATE mcp_configs SET grants='[{"serverId":2,"scopes":["exec"]},{"serverId":99,"scopes":["exec"]},{"serverId":1,"scopes":["read"]}]';
      INSERT INTO mcp_tokens(id,token_hash,user_id,name,server_ids,scopes,route_key,mode_tag,expires_at,created_at)
        VALUES('legacy','digest',7,'old','[99,1,2]','["exec"]','42','github',1,1);
      INSERT INTO mcp_activity(id,user_id,server_id,client,tool,status,started_at) VALUES('orphan',7,99,'MCP','test','success',1)`);
    f.reopen(); f.reopen();
    expect(db.prepare('SELECT grants FROM mcp_configs').get()?.grants).toBe('[{"serverId":1,"scopes":["read"]}]');
    expect(db.prepare('SELECT server_ids FROM mcp_tokens').get()?.server_ids).toBe('[1]');
    expect(db.prepare('SELECT * FROM mcp_activity').all()).toEqual([]);
    expect(await (await f.call({ action: 'servers', token })).json()).toEqual([expect.objectContaining({ id: 1 })]);
    db.close();
  });

  it('cannot issue a new ticket from an in-flight read after deletion commits', async () => {
    const f = fixture();
    f.database.exec("UPDATE servers SET auth_method='password', credential='test-only' WHERE id=1");
    let release!: (value: string) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(f.object as any, 'decryptCredential').mockImplementation(() => {
      started(); return new Promise<string>((resolve) => { release = resolve; });
    });
    const pending = f.ticket(1);
    await waiting;
    expect((await f.remove(1)).ok).toBe(true);
    release('test-only');
    expect((await pending).status).toBe(404);
    expect((f.object as any).connectTokens.size).toBe(0);
    f.database.close();
  });

  it('schedules retention without delaying earlier memory work and rearms after memory processing', async () => {
    const f = fixture();
    const memoryDue = Date.now() + 5000;
    await f.storage.setAlarm(memoryDue);
    const activity: McpActivity = { id: 'op', client: 'test', serverId: 1, tool: 'ssh_exec', status: 'success',
      startedAt: Date.now(), finishedAt: Date.now() };
    await f.call({ action: 'record', activity });
    expect(f.alarm()).toBe(memoryDue);
    // Alarm delivery consumes the current alarm. No memory task remains, so retention must rearm itself.
    const retention = activity.startedAt + 86400_000;
    await f.storage.setAlarm(null as never);
    await f.object.alarm();
    expect(f.alarm()).toBe(retention);
    // Later memory scheduling is still combined with the earlier retention deadline.
    await (f.object as any).scheduleMcpAlarm(retention + 5000);
    expect(f.alarm()).toBe(retention);
    f.database.close();
  });
});
