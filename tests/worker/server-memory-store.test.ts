import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerMemoryStore } from '../../src/worker/server-memory-store';
import { AGENT_KNOWLEDGE_TTL_MS } from '../../src/server-memory-schema';
import { buildExecutionLog } from '../../src/worker/agent/execution-log';
import { selectServerMemory } from '../../src/worker/agent/memory';
import type { OperationFact } from '../../src/worker/agent/execution-journal';

const sessionId = '12345678-1234-4123-8123-123456789abc';
const taskId = '12345678-1234-4123-8123-123456789def';
const now = 1_800_000_000_000;
const context = { sessionId, epoch: 0 };
const encode = (value: string) => 'encrypted:' + Buffer.from(value).toString('base64');
const decode = (value: string) => Buffer.from(value.slice('encrypted:'.length), 'base64').toString();

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE servers(id INTEGER PRIMARY KEY, user_id INTEGER);
    INSERT INTO servers VALUES(1,10),(2,20);
    CREATE TABLE server_work_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, server_id INTEGER,
      title TEXT, summary TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE server_knowledge(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, server_id INTEGER,
      category TEXT, key TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id,server_id,key));
    CREATE TABLE agent_knowledge_meta(user_id INTEGER, server_id INTEGER, key TEXT, source TEXT, scope TEXT,
      encrypted INTEGER DEFAULT 0, PRIMARY KEY(user_id,server_id,key));`);
  const sql = { exec(query: string, ...values: (string | number | null)[]) {
    if (query.includes('CREATE TABLE')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (statement.columns().length) return { toArray: () => statement.all(...values) };
    statement.run(...values);
    return { toArray: () => [] };
  } };
  const encrypt = vi.fn(async (value: string) => encode(value));
  const decrypt = vi.fn(async (value: string) => decode(value));
  const create = () => new ServerMemoryStore(sql as never, callback => {
    db.exec('BEGIN');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }, encrypt, decrypt);
  const store = create();
  const post = (action: string, body: Record<string, unknown>, serverId = 1) => store.handle(serverId, action,
    new Request('http://internal/memory', { method: 'POST', body: JSON.stringify({ user_id: 10, ...body }) }));
  const read = async () => {
    const res = await store.handle(1, 'memory', new Request('http://internal/memory?user_id=10'));
    expect(res.status).toBe(200);
    return await res.json<import('../../src/server-memory-schema').UnifiedServerMemory>();
  };
  return { db, create, store, post, read, encrypt };
}
let fixture: ReturnType<typeof setup>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); fixture = setup(); });
afterEach(() => { fixture.db.close(); vi.useRealTimers(); });

const fact: OperationFact = { taskId, callId: 'call_1', tool: 'execute_command', description: 'inspect nginx',
  status: 'unknown', executed: true, exitCode: -1, evidence: 'SECRET_TERMINAL', at: now };

describe('Memory store real SQLite transactions and migrations', () => {
  it('migrates old metadata idempotently without replacing user data', async () => {
    fixture.create();
    const columns = fixture.db.prepare('PRAGMA table_info(agent_knowledge_meta)').all().map(row => row.name);
    for (const name of ['evidence', 'task_id', 'verified_at', 'expires_at']) expect(columns).toContain(name);
    expect((await fixture.post('knowledge', { category: 'rule', key: 'deploy_rule', value: 'never restart' })).status).toBe(201);
    fixture.create();
    expect((await fixture.read()).knowledge[0]).toMatchObject({ key: 'deploy_rule', value: 'never restart', source: 'user' });
  });

  it('records complete execution statuses independently and deduplicates the same task ID', async () => {
    const operations = Array.from({ length: 86 }, (_, i) => ({ ...fact, callId: `call_${i}`, status: i === 43 ? 'unknown' as const : 'succeeded' as const, exitCode: i === 43 ? -1 : 0 }));
    const entry = buildExecutionLog(taskId, 'Inspect nginx token=SECRET_TOKEN', operations, 'stopped', 86, 'en-US');
    expect((await fixture.post('execution', { entry: { ...entry, reasoning: 'SECRET_REASONING' }, ...context })).status).toBe(200);
    expect((await fixture.post('execution', { entry, ...context })).status).toBe(200);
    const memory = await fixture.read();
    expect(memory.workLogs).toHaveLength(1);
    expect(memory.revision).toBe(1);
    expect(memory.workLogs[0].title).not.toContain('SECRET_TOKEN');
    const row = fixture.db.prepare('SELECT payload_enc FROM agent_execution_logs').get()!;
    expect(row.payload_enc).not.toContain('inspect nginx');
    const payload = JSON.parse(decode(String(row.payload_enc)));
    expect(payload.operations).toHaveLength(86);
    expect(payload.operations[43]).toMatchObject({ status: 'unknown', executed: true, exitCode: -1, at: now });
    expect(JSON.stringify(payload)).not.toMatch(/SECRET_TERMINAL|SECRET_REASONING/);
  });

  it('saves verification provenance and expires only automatically verified config/note facts', async () => {
    const values = [['config', 'nginx_port', '8080'], ['note', 'nginx_note', 'nginx'],
      ['rule', 'nginx_rule', 'never restart'], ['credential', 'nginx_token', 'SECRET_TOKEN']];
    expect((await fixture.post('batch', { ...context, taskId, expectedRevision: 0,
      knowledge: values.map(([category, key, value]) => ({ action: 'set', category, key, value, evidence: ['user'] })) })).status).toBe(200);
    await fixture.post('knowledge', { category: 'config', key: 'manual_port', value: '22' });
    const saved = await fixture.read();
    expect(saved.knowledge.find(item => item.key === 'nginx_port')).toMatchObject({ evidence: ['user'], task_id: taskId,
      verified_at: now, expires_at: now + AGENT_KNOWLEDGE_TTL_MS });
    const credential = fixture.db.prepare("SELECT value FROM server_knowledge WHERE key='nginx_token'").get()!;
    expect(credential.value).not.toContain('SECRET_TOKEN');
    vi.setSystemTime(now + AGENT_KNOWLEDGE_TTL_MS + 1);
    const expired = await fixture.read();
    expect(expired.knowledge.find(item => item.key === 'nginx_port')?.stale).toBe(true);
    for (const key of ['nginx_rule', 'nginx_token', 'manual_port']) {
      const item = expired.knowledge.find(item => item.key === key)!;
      expect(item.stale).toBe(false); expect(item.expires_at).toBeUndefined();
    }
    expect(selectServerMemory(expired, 'nginx_port nginx_note nginx_token').knowledge.map(item => item.key))
      .not.toEqual(expect.arrayContaining(['nginx_port', 'nginx_note']));
  });

  it('keeps user ownership and non-expiry after an explicitly authorized agent update', async () => {
    await fixture.post('knowledge', { category: 'config', key: 'user_port', value: '22' });
    const memory = await fixture.read();
    const result = await fixture.post('batch', { ...context, taskId, expectedRevision: memory.revision,
      knowledge: [{ action: 'set', category: 'config', key: 'user_port', value: '23', evidence: ['user'] }] });
    expect(result.status).toBe(200);
    const item = (await fixture.read()).knowledge[0];
    expect(item).toMatchObject({ value: '23', source: 'user', evidence: ['user'] });
    expect(item.expires_at).toBeUndefined();
  });

  it('returns a machine-readable revision conflict after encryption yields, with no partial writes', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    fixture.encrypt.mockImplementationOnce(async value => { await blocked; return encode(value); });
    const pending = fixture.post('batch', { ...context, taskId, expectedRevision: 0,
      knowledge: [{ action: 'set', category: 'credential', key: 'new_token', value: 'SECRET', evidence: ['user'] }] });
    await Promise.resolve(); await Promise.resolve();
    await fixture.post('knowledge', { category: 'config', key: 'user_port', value: '443' });
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'memory_revision_conflict' });
    expect((await fixture.read()).knowledge.map(item => item.key)).toEqual(['user_port']);
  });

  it('rejects stale sessions after crypto and never classifies that as a revision retry', async () => {
    await fixture.post('session', context);
    let release!: () => void;
    fixture.encrypt.mockImplementationOnce(async value => { await new Promise<void>(resolve => { release = resolve; }); return encode(value); });
    const entry = buildExecutionLog(taskId, 'Inspect', [fact], 'stopped', 1, 'en-US');
    const pending = fixture.post('execution', { entry, ...context });
    await Promise.resolve(); await Promise.resolve();
    await fixture.post('session', { ...context, epoch: 1 });
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).not.toHaveProperty('code', 'memory_revision_conflict');
    expect((await fixture.read()).workLogs).toEqual([]);
  });

  it('rejects invalid mixed batches atomically and enforces ownership', async () => {
    const bad = await fixture.post('batch', { expectedRevision: 0,
      knowledge: [{ action: 'set', category: 'config', key: 'port', value: '22' }], workLog: { title: '', summary: '' } });
    expect(bad.status).toBe(400);
    expect((await fixture.read()).knowledge).toEqual([]);
    const forbidden = await fixture.post('knowledge', { key: 'port', value: '22' }, 2);
    expect(forbidden.status).toBe(403);
  });

  it('rolls back all knowledge when the revision write fails instead of reporting success', async () => {
    await fixture.read();
    fixture.db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE ON agent_memory_state BEGIN SELECT RAISE(ABORT, 'SECRET_SQL_ERROR'); END");
    const res = await fixture.post('batch', { ...context, taskId, expectedRevision: 0,
      knowledge: [{ action: 'set', category: 'config', key: 'port', value: '22', evidence: ['user'] }] });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('SECRET_SQL_ERROR');
    const memory = await fixture.read();
    expect(memory.knowledge).toEqual([]);
    expect(memory.revision).toBe(0);
  });

  it('does not swallow session or recovery checkpoint storage failures', async () => {
    fixture.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON agent_memory_sessions BEGIN SELECT RAISE(ABORT, 'SECRET_SQL_ERROR'); END");
    expect((await fixture.post('session', context)).status).toBe(500);
    fixture.db.exec('DROP TRIGGER fail_session');
    fixture.db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON agent_task_checkpoints BEGIN SELECT RAISE(ABORT, 'SECRET_SQL_ERROR'); END");
    const checkpoint = buildExecutionLog(taskId, 'Inspect', [fact], 'stopped', 1, 'en-US');
    const res = await fixture.post('checkpoint', { ...context, checkpoint });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('SECRET_SQL_ERROR');
  });

  it('cleans encrypted execution evidence when its work log is deleted', async () => {
    await fixture.post('execution', { entry: buildExecutionLog(taskId, 'Inspect', [fact], 'stopped', 1, 'en-US'), ...context });
    const memory = await fixture.read();
    const res = await fixture.store.handle(1, 'work-log', new Request('http://internal/memory?user_id=10', { method: 'DELETE' }), memory.workLogs[0].id);
    expect(res.status).toBe(200);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM agent_execution_logs').get()!.n).toBe(0);
  });

  it('deletes metadata by knowledge key, never an unrelated SQLite rowid', async () => {
    await fixture.post('knowledge', { category: 'credential', key: 'keep_token', value: 'KEEP_SECRET' });
    await fixture.post('knowledge', { category: 'credential', key: 'remove_token', value: 'REMOVE_SECRET' });
    fixture.db.exec("UPDATE agent_knowledge_meta SET rowid=50 WHERE key='remove_token'");
    const memory = await fixture.read();
    const res = await fixture.store.handle(1, 'knowledge', new Request('http://internal/memory?user_id=10', { method: 'DELETE' }), memory.knowledge.find(item => item.key === 'remove_token')!.id);
    expect(res.status).toBe(200);
    expect(fixture.db.prepare('SELECT key FROM agent_knowledge_meta').all().map(row => row.key)).toEqual(['keep_token']);
    expect((await fixture.read()).knowledge[0].value).toBe('KEEP_SECRET');
  });
});
