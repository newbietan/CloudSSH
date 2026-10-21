import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerMemoryStore } from '../../src/worker/server-memory-store';
import type { MemoryTask } from '../../src/worker/agent/types';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE servers(id INTEGER PRIMARY KEY, user_id INTEGER);
    INSERT INTO servers VALUES(1,10),(2,20);
    CREATE TABLE server_work_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, server_id INTEGER,
      title TEXT, summary TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE server_knowledge(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, server_id INTEGER,
      category TEXT, key TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id,server_id,key));`);
  const sql = { exec(query: string, ...values: (string | number | null)[]) {
    if (query.includes('CREATE TABLE')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (statement.columns().length) return { toArray: () => statement.all(...values) };
    statement.run(...values); return { toArray: () => [] };
  } };
  const create = () => new ServerMemoryStore(sql as never, callback => {
    db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }, async value => 'enc:' + Buffer.from(value).toString('base64'),
  async value => Buffer.from(value.slice(4), 'base64').toString());
  const store = create();
  const post = (action: string, body: Record<string, unknown>) => store.handle(1, action,
    new Request('http://internal/memory', { method: 'POST', body: JSON.stringify({ user_id: 10, ...body }) }));
  return { db, create, store, post };
}
let f: ReturnType<typeof setup>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); f = setup(); });
afterEach(() => { f.db.close(); vi.useRealTimers(); });
const task: MemoryTask = { taskId: 'task-1', goal: '部署', conversation: '配置和部署操作', locale: 'zh-CN', timezone: 'UTC' };

describe('Saved memory and simple retry persistence', () => {
  it('stores and returns a complete reusable private key using the existing encrypted storage', async () => {
    const key = '  -----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(2000) + '\n-----END PRIVATE KEY-----\n';
    expect((await f.post('knowledge', { category: 'credential', key: 'deploy_key', value: key })).status).toBe(201);
    expect((await f.create().read(1, 10)).knowledge[0].value).toBe(key);
    expect(f.db.prepare('SELECT value FROM server_knowledge').get()?.value).not.toContain('BEGIN PRIVATE KEY');
    vi.setSystemTime(Date.now() + 90 * 86400_000);
    expect((await f.store.read(1, 10)).knowledge[0].value).toBe(key); // No automatic expiry/filtering.
  });

  it('creates work logs, merges a recent continuation and updates/deletes knowledge', async () => {
    await f.post('work-log', { title: '部署应用', summary: '应用已启动' });
    await f.store.saveBatch(1, 10, { workLog: { mode: 'update_latest', title: '部署并验证', summary: '应用启动后验证正常' },
      knowledge: [{ category: 'config', key: 'port', value: '8080' }] });
    const memory = await f.store.read(1, 10);
    expect(memory.workLogs).toHaveLength(1);
    expect(memory.workLogs[0].title).toBe('部署并验证');
    await f.store.saveBatch(1, 10, { knowledge: [{ action: 'delete', key: 'port' }] });
    expect((await f.store.read(1, 10)).knowledge).toEqual([]);
  });

  it('does not overwrite a concurrent memory update', async () => {
    await f.post('knowledge', { key: 'port', value: '443' });
    await expect(f.store.saveBatch(1, 10, { expectedRevision: 0,
      knowledge: [{ key: 'port', value: '22' }] })).rejects.toMatchObject({ status: 409 });
    expect((await f.store.read(1, 10)).knowledge[0].value).toBe('443');
  });

  it('commits the summary and removes its pending task together, so a repeated Alarm cannot append it again', async () => {
    await f.store.enqueueMemory(1, 10, task);
    const row = f.store.nextTask()!;
    expect((await f.create().taskInput(row)).conversation).toBe(task.conversation);
    const batch = { workLog: { title: '完成部署', summary: '服务部署正常' } };
    await f.store.saveBatch(1, 10, batch, row);
    expect(f.create().nextTask()).toBeUndefined();
    await expect(f.store.saveBatch(1, 10, batch, row)).rejects.toMatchObject({ status: 409 });
    expect((await f.store.read(1, 10)).workLogs).toHaveLength(1);
  });

  it('rolls back both writes and task deletion when the transaction fails', async () => {
    await f.store.enqueueMemory(1, 10, task);
    const row = f.store.nextTask()!;
    await f.store.read(1, 10);
    f.db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE ON agent_memory_state BEGIN SELECT RAISE(ABORT, 'failed'); END");
    await expect(f.store.saveBatch(1, 10, { workLog: { title: '部署', summary: '部署完成' } }, row)).rejects.toThrow();
    expect((await f.store.read(1, 10)).workLogs).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM agent_pending_distillations').get()).toEqual({ n: 1 });
  });

  it('keeps server ownership isolation and removes pending work when the server is deleted', async () => {
    await expect(f.store.read(2, 10)).rejects.toMatchObject({ status: 403 });
    await f.store.enqueueMemory(1, 10, task);
    f.store.cleanup(1);
    expect(f.store.nextTask()).toBeUndefined();
  });
});
