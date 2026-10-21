import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserDBDO } from '../../../src/worker/user-db';
import { responseObject } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
const now = 1_800_000_000_000;
function setup() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...params: (string | number | null)[]) {
    if (/CREATE TABLE|DROP TABLE/.test(query)) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (statement.columns().length) return { toArray: () => statement.all(...params) };
    statement.run(...params); return { toArray: () => [] };
  } };
  const storage = { sql, setAlarm: vi.fn(async (_at: number) => {}), transactionSync<T>(fn: () => T) {
    db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  const create = () => {
    const instance = new UserDBDO({ storage, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() } as never, {} as never);
    vi.spyOn(instance as any, 'encryptCredential').mockImplementation(async value => 'enc:' + Buffer.from(String(value)).toString('base64'));
    vi.spyOn(instance as any, 'decryptCredential').mockImplementation(async value => Buffer.from(String(value).slice(4), 'base64').toString());
    return instance;
  };
  const instance = create();
  db.exec(`INSERT INTO users(id, github_id, username) VALUES(10,123,'owner');
    INSERT INTO servers(id,user_id,name,host,username,credential) VALUES(1,10,'server','example.com','root','fixture');`);
  const post = (owner: UserDBDO, route: string, body: unknown, method = 'POST') => owner.fetch(new Request('http://internal/internal/' + route,
    { method, body: JSON.stringify({ user_id: 10, ...body as object }) }));
  const configure = (key: string) => post(instance, 'ai-config', { base_url: 'https://llm.example.com', model: 'test', api_key: key }, 'PUT');
  return { db, instance, create, post, configure };
}
let f: ReturnType<typeof setup>;
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); f = setup();
  await f.configure('ORIGINAL_KEY');
  const queued = await f.post(f.instance, 'servers/1/agent-memory', { task: { taskId: 'task-1', goal: '部署服务',
    conversation: '用户给过已有密钥，读取配置后完成部署', locale: 'zh-CN', timezone: 'UTC' } });
  expect(queued.status).toBe(200);
});
afterEach(() => { f?.db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Server memory and background extraction', () => {
  it('serves manual memory CRUD with ownership checks and cleans pending work when deleting the server', async () => {
    const get = (userId = 10) => f.instance.fetch(new Request(`http://internal/internal/servers/1/memory?user_id=${userId}`));
    expect((await get(999)).status).toBe(403);
    const secret = '  secret-with-spaces\n';
    const saved = await f.post(f.instance, 'servers/1/knowledge', { category: 'credential', key: 'deploy_key', value: secret });
    expect(saved.status).toBe(201);
    const entry = await saved.json() as { id: number; value: string };
    expect(entry.value).toBe(secret);
    const log = await f.post(f.instance, 'servers/1/work-logs', { title: '完成部署', summary: '应用已正常启动。' });
    expect(log.status).toBe(201);
    const workLog = await log.json() as { id: number };
    expect(await (await get()).json()).toMatchObject({ knowledge: [{ value: secret }], workLogs: [{ title: '完成部署' }] });
    const deleted = await f.post(f.instance, 'servers/1/knowledge/batch', { ids: [entry.id] }, 'DELETE');
    expect(deleted.status).toBe(200);
    expect((await f.instance.fetch(new Request(`http://internal/internal/servers/1/work-logs/${workLog.id}?user_id=10`, { method: 'DELETE' }))).status).toBe(200);
    expect(await (await get()).json()).toMatchObject({ knowledge: [], workLogs: [] });
    expect((await f.post(f.instance, 'servers/1', {}, 'DELETE')).status).toBe(200);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_pending_distillations').get()).toEqual({ n: 0 });
  });

  it('resumes after reconstruction, uses the current API config, and saves reusable credentials once', async () => {
    await f.configure('ROTATED_KEY');
    const key = 'secret-' + 'X'.repeat(1000);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://llm.example.com/responses');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ROTATED_KEY');
      return Response.json(responseObject('summary', JSON.stringify({ workLog: { mode: 'create', title: '完成部署', summary: '使用已有配置完成部署。' },
        knowledge: [{ action: 'set', category: 'credential', key: 'deploy_key', value: key }] })));
    });
    const recovered = f.create();
    await recovered.alarm(); await recovered.alarm();
    expect(fetch).toHaveBeenCalledTimes(1);
    const memory = await recovered.fetch(new Request('http://internal/internal/servers/1/memory?user_id=10'));
    expect(await memory.json()).toMatchObject({ workLogs: [{ title: '完成部署' }], knowledge: [{ value: key }] });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_pending_distillations').get()).toEqual({ n: 0 });
  });

  it('retries at most three times after the first failure, then deletes the pending task', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 }));
    for (let attempt = 1; attempt <= 4; attempt++) {
      await f.create().alarm();
      expect(fetch).toHaveBeenCalledTimes(attempt);
      if (attempt < 4) {
        const row = f.db.prepare('SELECT retries, next_attempt_at FROM agent_pending_distillations').get()!;
        expect(row.retries).toBe(attempt);
        expect(row.next_attempt_at).toBe(Date.now() + 2000 * 2 ** (attempt - 1));
        vi.setSystemTime(Number(row.next_attempt_at));
      }
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_pending_distillations').get()).toEqual({ n: 0 });
    await f.create().alarm(); expect(fetch).toHaveBeenCalledTimes(4);
  });
});
