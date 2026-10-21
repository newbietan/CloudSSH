import { CONSECUTIVE_TASK_WINDOW_MS, isSensitiveKeyOrValue, MAX_SERVER_KNOWLEDGE,
  MAX_SERVER_WORK_LOGS, normalizeBatchDeleteKnowledgeInput, normalizeKnowledgeInput,
  normalizeWorkLogInput, type ServerKnowledgeItem, type ServerWorkLog,
  type UnifiedServerMemory } from '../server-memory-schema';
import type { AgentMemoryBatch, MemoryTask } from './agent/types';
import { bytes } from './agent/context-limits';

class MemoryStoreError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
function storedJSON(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Report the stored-data error without echoing its content. */ }
  throw new MemoryStoreError(500, 'Invalid saved memory');
}

export interface PendingMemoryTask {
  user_id: number; server_id: number; task_id: string; payload_enc: string;
  retries: number; next_attempt_at: number;
}
type Knowledge = Extract<ReturnType<typeof normalizeKnowledgeInput>, { ok: true }>['value'] & { encrypted: number };

/** Saved server memory and its small Alarm-backed retry queue. */
export class ServerMemoryStore {
  constructor(private db: SqlStorage, private transaction: <T>(callback: () => T) => T,
    private encrypt: (value: string, userId: number) => Promise<string>,
    private decrypt: (value: string, userId: number) => Promise<string>,
    private scheduleAlarm?: (at: number) => Promise<void>) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory_state (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id, server_id)
      );
      CREATE TABLE IF NOT EXISTS agent_knowledge_meta (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', encrypted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id, server_id, key)
      );
      CREATE TABLE IF NOT EXISTS agent_pending_distillations (
        user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, task_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '', epoch INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0, payload_enc TEXT NOT NULL, updated_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, server_id, task_id)
      );
      DROP TABLE IF EXISTS agent_memory_sessions;
      DROP TABLE IF EXISTS agent_task_checkpoints;
      DROP TABLE IF EXISTS agent_execution_logs;
      DROP TABLE IF EXISTS agent_memory_receipts;
    `);
    // Keep old stored credentials/jobs readable; the old source/scope/session columns are no longer used.
    const columns = this.query<{ name: string }>('PRAGMA table_info(agent_pending_distillations)');
    if (!columns.some(column => column.name === 'next_attempt_at')) {
      db.exec('ALTER TABLE agent_pending_distillations ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_due ON agent_pending_distillations(next_attempt_at)');
  }

  private query<T>(sql: string, ...values: (string | number | null)[]): T[] {
    // SAFETY: each caller specifies the row shape returned by its fixed SELECT statement.
    return this.db.exec(sql, ...values).toArray() as unknown as T[];
  }

  private checkOwner(serverId: number, userId: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new MemoryStoreError(400, 'Invalid user_id');
    const server = this.query<{ user_id: number }>('SELECT user_id FROM servers WHERE id = ?', serverId)[0];
    if (!server) throw new MemoryStoreError(404, 'Server not found');
    if (server.user_id !== userId) throw new MemoryStoreError(403, 'Forbidden');
  }

  private revision(serverId: number, userId: number): number {
    this.db.exec("INSERT OR IGNORE INTO agent_memory_state(user_id, server_id, revision, scope) VALUES (?, ?, 0, '')", userId, serverId);
    return this.query<{ revision: number }>('SELECT revision FROM agent_memory_state WHERE user_id = ? AND server_id = ?', userId, serverId)[0]?.revision ?? 0;
  }

  private bump(serverId: number, userId: number): void {
    this.db.exec('UPDATE agent_memory_state SET revision = revision + 1 WHERE user_id = ? AND server_id = ?', userId, serverId);
  }

  async read(serverId: number, userId: number): Promise<UnifiedServerMemory> {
    this.checkOwner(serverId, userId);
    const revision = this.revision(serverId, userId);
    const workLogs = this.query<ServerWorkLog>(`SELECT id, user_id, server_id, title, summary, created_at, updated_at
      FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`, serverId, userId, MAX_SERVER_WORK_LOGS);
    const knowledge = this.query<ServerKnowledgeItem>(`SELECT id, user_id, server_id, category, key, value, created_at, updated_at
      FROM server_knowledge WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`, serverId, userId, MAX_SERVER_KNOWLEDGE);
    const encrypted = new Set(this.query<{ key: string; encrypted: number }>(
      'SELECT key, encrypted FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ?', userId, serverId)
      .filter(item => item.encrypted).map(item => item.key));
    for (const item of knowledge) if (encrypted.has(item.key)) {
      const stored = storedJSON(await this.decrypt(item.value, userId));
      if (stored.purpose !== 'server-knowledge' || stored.serverId !== serverId || stored.key !== item.key || typeof stored.value !== 'string') {
        throw new MemoryStoreError(500, 'Invalid saved knowledge');
      }
      item.value = stored.value;
    }
    return { workLogs, knowledge, revision };
  }

  private async prepareKnowledge(serverId: number, userId: number, input: Parameters<typeof normalizeKnowledgeInput>[0]): Promise<Knowledge> {
    const value = normalizeKnowledgeInput(input);
    if (!value.ok) throw new MemoryStoreError(400, value.error);
    const encrypted = value.value.action === 'set' && (value.value.category === 'credential' || isSensitiveKeyOrValue(value.value.key, value.value.value)) ? 1 : 0;
    return { ...value.value, encrypted, value: encrypted ? await this.encrypt(JSON.stringify({ purpose: 'server-knowledge',
      serverId, key: value.value.key, value: value.value.value }), userId) : value.value.value };
  }

  private writeKnowledge(serverId: number, userId: number, item: Knowledge): void {
    if (item.action === 'delete') {
      this.db.exec('DELETE FROM server_knowledge WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, item.key);
      this.db.exec('DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, item.key);
      return;
    }
    const now = Date.now();
    this.db.exec(`INSERT INTO server_knowledge(user_id, server_id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, server_id, key) DO UPDATE SET category = excluded.category, value = excluded.value, updated_at = excluded.updated_at`,
      userId, serverId, item.category, item.key, item.value, now, now);
    this.db.exec(`INSERT INTO agent_knowledge_meta(user_id, server_id, key, source, scope, encrypted) VALUES (?, ?, ?, '', '', ?)
      ON CONFLICT(user_id, server_id, key) DO UPDATE SET encrypted = excluded.encrypted`, userId, serverId, item.key, item.encrypted);
  }

  private writeLog(serverId: number, userId: number, log: { title: string; summary: string; mode?: string }): void {
    const latest = log.mode === 'update_latest' ? this.query<{ id: number; updated_at: number }>(
      'SELECT id, updated_at FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1', serverId, userId)[0] : undefined;
    const now = Date.now();
    if (latest && now - latest.updated_at <= CONSECUTIVE_TASK_WINDOW_MS) {
      this.db.exec('UPDATE server_work_logs SET title = ?, summary = ?, updated_at = ? WHERE id = ? AND user_id = ? AND server_id = ?',
        log.title, log.summary, now, latest.id, userId, serverId);
    } else {
      this.db.exec('INSERT INTO server_work_logs(user_id, server_id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        userId, serverId, log.title, log.summary, now, now);
    }
  }

  private trim(serverId: number, userId: number): void {
    this.db.exec(`DELETE FROM server_work_logs WHERE server_id = ? AND user_id = ? AND id NOT IN (
      SELECT id FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`, serverId, userId, serverId, userId, MAX_SERVER_WORK_LOGS);
    this.db.exec(`DELETE FROM server_knowledge WHERE server_id = ? AND user_id = ? AND id NOT IN (
      SELECT id FROM server_knowledge WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`, serverId, userId, serverId, userId, MAX_SERVER_KNOWLEDGE);
    this.db.exec(`DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key NOT IN (
      SELECT key FROM server_knowledge WHERE user_id = ? AND server_id = ?)`, userId, serverId, userId, serverId);
  }

  async saveBatch(serverId: number, userId: number, batch: AgentMemoryBatch,
    task?: PendingMemoryTask, signal?: AbortSignal): Promise<void> {
    this.checkOwner(serverId, userId);
    const raw = batch.knowledge ?? [];
    if (!Array.isArray(raw) || raw.length > 100) throw new MemoryStoreError(400, 'Invalid knowledge batch');
    const knowledge = await Promise.all(raw.map(item => this.prepareKnowledge(serverId, userId, item)));
    const log = batch.workLog ? normalizeWorkLogInput(batch.workLog) : null;
    if (log && !log.ok) throw new MemoryStoreError(400, log.error);
    this.transaction(() => {
      signal?.throwIfAborted();
      this.checkOwner(serverId, userId);
      if (task) {
        const current = this.query<PendingMemoryTask>('SELECT retries, next_attempt_at FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, task.task_id)[0];
        if (!current || current.retries !== task.retries || current.next_attempt_at !== task.next_attempt_at || Date.now() >= task.next_attempt_at) {
          throw new MemoryStoreError(409, 'Task already handled');
        }
      }
      const revision = this.revision(serverId, userId);
      if (batch.expectedRevision !== undefined && batch.expectedRevision !== revision) {
        throw new MemoryStoreError(409, 'Memory changed', 'memory_revision_conflict');
      }
      for (const item of knowledge) this.writeKnowledge(serverId, userId, item);
      if (log?.ok) this.writeLog(serverId, userId, log.value);
      this.trim(serverId, userId); this.bump(serverId, userId);
      if (task) this.db.exec('DELETE FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, task.task_id);
    });
  }

  private deleteKnowledge(serverId: number, userId: number, id: number): void {
    const row = this.query<{ key: string }>('SELECT key FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?', id, serverId, userId)[0];
    this.db.exec('DELETE FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?', id, serverId, userId);
    if (row) this.db.exec('DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, row.key);
  }

  async handle(serverId: number, action: string, request: Request, itemId?: number): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && action === 'memory') return Response.json(await this.read(serverId, Number(url.searchParams.get('user_id'))));
      if (request.method === 'DELETE' && action !== 'knowledge-batch') {
        const userId = Number(url.searchParams.get('user_id'));
        this.checkOwner(serverId, userId); this.revision(serverId, userId);
        this.transaction(() => {
          if (action === 'work-log') this.db.exec('DELETE FROM server_work_logs WHERE id = ? AND server_id = ? AND user_id = ?', itemId!, serverId, userId);
          else this.deleteKnowledge(serverId, userId, itemId!);
          this.bump(serverId, userId);
        });
        return Response.json({ success: true });
      }
      const body = await request.json<Record<string, unknown>>();
      const userId = Number(body.user_id);
      this.checkOwner(serverId, userId);
      if (action === 'task') {
        await this.enqueueMemory(serverId, userId, body.task as MemoryTask);
        return Response.json({ success: true });
      }
      if (action === 'knowledge-batch') {
        const ids = normalizeBatchDeleteKnowledgeInput(body);
        if (!ids.ok) throw new MemoryStoreError(400, ids.error);
        this.revision(serverId, userId);
        this.transaction(() => {
          for (const id of ids.value.ids) this.deleteKnowledge(serverId, userId, id);
          this.bump(serverId, userId);
        });
        return Response.json({ success: true, count: ids.value.ids.length });
      }
      if (action === 'knowledge') {
        const key = normalizeKnowledgeInput(body);
        if (!key.ok) throw new MemoryStoreError(400, key.error);
        await this.saveBatch(serverId, userId, { knowledge: [key.value] });
        const saved = this.query<ServerKnowledgeItem>('SELECT id, user_id, server_id, category, key, value, created_at, updated_at FROM server_knowledge WHERE server_id = ? AND user_id = ? AND key = ?',
          serverId, userId, key.value.key)[0];
        return Response.json(saved ? { ...saved, value: key.value.value } : { success: true }, { status: 201 });
      }
      if (action === 'work-log') {
        await this.saveBatch(serverId, userId, { workLog: body as AgentMemoryBatch['workLog'] });
        const saved = this.query<ServerWorkLog>('SELECT id, user_id, server_id, title, summary, created_at, updated_at FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1', serverId, userId)[0];
        return Response.json(saved, { status: 201 });
      }
      throw new MemoryStoreError(404, 'Unknown memory action');
    } catch (error) {
      if (error instanceof MemoryStoreError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      return Response.json({ error: 'Memory storage failed' }, { status: 500 });
    }
  }

  async enqueueMemory(serverId: number, userId: number, task: MemoryTask): Promise<void> {
    if (!task || typeof task.taskId !== 'string' || !task.taskId || task.taskId.length > 128 ||
      typeof task.goal !== 'string' || typeof task.conversation !== 'string' || bytes(task) > 128 * 1024) {
      throw new MemoryStoreError(400, 'Invalid memory task');
    }
    this.checkOwner(serverId, userId);
    const payload = await this.encrypt(JSON.stringify({ purpose: 'pending-distillation', serverId, job: task }), userId);
    this.checkOwner(serverId, userId);
    this.db.exec(`INSERT OR IGNORE INTO agent_pending_distillations(user_id, server_id, task_id, session_id, epoch, retries, payload_enc, updated_at, next_attempt_at)
      VALUES (?, ?, ?, '', 0, 0, ?, ?, ?)`, userId, serverId, task.taskId, payload, Date.now(), Date.now());
    await this.rearm();
  }

  /** Reserve one due row by advancing its wake time, so a crash also has a scheduled retry. */
  nextTask(): PendingMemoryTask | undefined {
    return this.transaction(() => {
      const now = Date.now();
      this.db.exec('DELETE FROM agent_pending_distillations WHERE retries >= 4 AND next_attempt_at <= ?', now);
      const row = this.query<PendingMemoryTask>('SELECT * FROM agent_pending_distillations WHERE next_attempt_at <= ? ORDER BY updated_at, task_id LIMIT 1', now)[0];
      if (!row) return;
      row.retries++; row.next_attempt_at = now + 30_000;
      this.db.exec('UPDATE agent_pending_distillations SET retries = ?, next_attempt_at = ? WHERE user_id = ? AND server_id = ? AND task_id = ?',
        row.retries, row.next_attempt_at, row.user_id, row.server_id, row.task_id);
      return row;
    });
  }

  async taskInput(row: PendingMemoryTask): Promise<MemoryTask> {
    this.checkOwner(row.server_id, row.user_id);
    const payload = storedJSON(await this.decrypt(row.payload_enc, row.user_id));
    if (payload.purpose !== 'pending-distillation' || payload.serverId !== row.server_id ||
      !payload.job || typeof payload.job !== 'object') throw new MemoryStoreError(400, 'Invalid memory task');
    const job = payload.job as Record<string, unknown>;
    // Read old failed jobs without restoring the old configuration or auxiliary evidence machinery.
    return { taskId: row.task_id, goal: String(job.goal ?? ''),
      conversation: typeof job.conversation === 'string' ? job.conversation : JSON.stringify(job.records ?? []),
      locale: job.locale === 'en-US' || job.locale === 'zh-TW' ? job.locale : 'zh-CN',
      timezone: typeof job.timezone === 'string' ? job.timezone : 'UTC' };
  }

  retryTask(row: PendingMemoryTask): void {
    if (row.retries >= 4) this.db.exec('DELETE FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND task_id = ? AND retries = ?', row.user_id, row.server_id, row.task_id, row.retries);
    else this.db.exec('UPDATE agent_pending_distillations SET next_attempt_at = ? WHERE user_id = ? AND server_id = ? AND task_id = ? AND retries = ?',
      Date.now() + 2000 * 2 ** (row.retries - 1), row.user_id, row.server_id, row.task_id, row.retries);
  }

  async rearm(): Promise<void> {
    const row = this.query<{ due: number | null }>('SELECT MIN(next_attempt_at) AS due FROM agent_pending_distillations')[0];
    if (row?.due != null && this.scheduleAlarm) await this.scheduleAlarm(Math.max(Date.now() + 1, row.due));
  }

  cleanup(serverId: number): void {
    this.db.exec('DELETE FROM agent_memory_state WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM agent_knowledge_meta WHERE server_id = ?', serverId);
    this.db.exec('DELETE FROM agent_pending_distillations WHERE server_id = ?', serverId);
  }
}
