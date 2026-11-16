import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { UserDBDO } from '../../src/worker/user-db';
import type { McpActivity } from '../../src/mcp-schema';

function fixture() {
  const database = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...params: any[]) {
    let result: unknown[] = [];
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) result = database.prepare(query).all(...params);
    else if (params.length) database.prepare(query).run(...params);
    else database.exec(query);
    return { toArray: () => result };
  } };
  let alarm: number | null = null;
  const storage = { sql, getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } };
  const object = new UserDBDO({ storage } as unknown as DurableObjectState, {} as never);
  database.exec(`INSERT INTO users(id, github_id, username) VALUES (7,42,'owner'),(8,43,'other');
    INSERT INTO servers(id,user_id,name,host,port,username,credential,auth_method) VALUES
      (1,7,'target','target.example.com',22,'owner','','none'),
      (2,8,'other','other.example.com',22,'other','','none');`);
  const call = async (body: Record<string, unknown>) => object.fetch(new Request('http://internal/internal/mcp', {
    method: 'POST', body: JSON.stringify({ userId: 7, routeKey: '42', modeTag: 'github', ...body }),
  }));
  return { database, object, call, storage, alarm: () => alarm };
}
describe('MCP saved configuration and shared Alarm integration', () => {
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
