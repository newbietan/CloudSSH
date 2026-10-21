import { TASK_CHECKPOINT_MAX_COUNT, TASK_CHECKPOINT_TTL_MS, TASK_ID_PATTERN,
  validTaskCheckpoint } from '../agent-task-schema';
import { AGENT_KNOWLEDGE_TTL_MS, CONSECUTIVE_TASK_WINDOW_MS, isSensitiveKeyOrValue, MAX_SERVER_KNOWLEDGE,
  MAX_SERVER_WORK_LOGS, normalizeBatchDeleteKnowledgeInput, normalizeKnowledgeInput,
  normalizeWorkLogInput, type ServerKnowledgeItem, type ServerWorkLog,
  type UnifiedServerMemory } from '../server-memory-schema';

class MemoryStoreError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
function storedObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* No stored plaintext is forwarded in errors. */ }
  throw new MemoryStoreError(500, 'Invalid encrypted memory');
}
type StateRow = { revision: number; scope: string };
type MetaRow = { key: string; source: 'user' | 'agent' | 'legacy'; scope: string; encrypted: number;
  evidence?: string | null; task_id?: string | null; verified_at?: number | null; expires_at?: number | null };
type KnowledgeProof = { evidence?: string[]; taskId?: string; verifiedAt?: number; expiresAt?: number };
type NormalizedKnowledge = { action: 'set' | 'delete'; category: string; key: string; value: string;
  encrypted: number; evidence?: string[] };

/** UserDBDO-owned memory. Crypto awaits happen BEFORE synchronous, revision-checked commits. */
export class ServerMemoryStore {
  private memoryStates = new Map<string, StateRow>();

  constructor(private db: SqlStorage, private transaction: <T>(callback: () => T) => T,
    private encrypt: (value: string, userId: number) => Promise<string>,
    private decrypt: (value: string, userId: number) => Promise<string>) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_state (
          user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
          scope TEXT NOT NULL, PRIMARY KEY(user_id, server_id)
        );
        CREATE TABLE IF NOT EXISTS agent_knowledge_meta (
          user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, key TEXT NOT NULL,
          source TEXT NOT NULL, scope TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(user_id, server_id, key)
        );
        CREATE TABLE IF NOT EXISTS agent_memory_sessions (
          user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, session_id TEXT NOT NULL,
          epoch INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(user_id, server_id, session_id)
        );
        CREATE TABLE IF NOT EXISTS agent_task_checkpoints (
          user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, task_id TEXT NOT NULL,
          session_id TEXT NOT NULL, epoch INTEGER NOT NULL, scope TEXT NOT NULL,
          payload_enc TEXT NOT NULL, step INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, server_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_expiry ON agent_task_checkpoints(expires_at);
        CREATE TABLE IF NOT EXISTS agent_pending_distillations (
          user_id INTEGER NOT NULL, server_id INTEGER NOT NULL, task_id TEXT NOT NULL,
          session_id TEXT NOT NULL, epoch INTEGER NOT NULL, retries INTEGER NOT NULL DEFAULT 0,
          payload_enc TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(user_id, server_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_pending_distillations ON agent_pending_distillations(user_id, server_id);
      `);
      const columns = new Set(this.query<{ name: string }>('PRAGMA table_info(agent_knowledge_meta)').map(row => row.name));
      const migrations = [
        ['evidence', 'ALTER TABLE agent_knowledge_meta ADD COLUMN evidence TEXT'],
        ['task_id', 'ALTER TABLE agent_knowledge_meta ADD COLUMN task_id TEXT'],
        ['verified_at', 'ALTER TABLE agent_knowledge_meta ADD COLUMN verified_at INTEGER'],
        ['expires_at', 'ALTER TABLE agent_knowledge_meta ADD COLUMN expires_at INTEGER'],
      ];
      for (const [name, sql] of migrations) if (!columns.has(name)) db.exec(sql);
    } catch {
      /* ignore schema initialization errors in mock environments */
    }
  }

  private query<T>(sql: string, ...values: (string | number | null)[]): T[] {
    // SAFETY: each caller supplies a row shape matching its explicit SELECT columns.
    return this.db.exec(sql, ...values).toArray() as unknown as T[];
  }

  private scope(serverId: number, userId: number): string {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new MemoryStoreError(400, 'Invalid user_id');
    const row = this.query<{ user_id: number }>('SELECT user_id FROM servers WHERE id = ?', serverId)[0];
    if (!row) throw new MemoryStoreError(404, 'Server not found');
    if (row.user_id !== userId) throw new MemoryStoreError(403, 'Forbidden');
    return `server:${serverId}:user:${userId}`;
  }

  private state(serverId: number, userId: number): StateRow {
    const key = `${userId}:${serverId}`;
    const scope = this.scope(serverId, userId);
    let state: StateRow | undefined = this.query<StateRow>('SELECT revision, scope FROM agent_memory_state WHERE user_id = ? AND server_id = ?', userId, serverId)[0];
    if (!state) state = this.memoryStates.get(key);
    if (!state) {
      this.db.exec('INSERT INTO agent_memory_state (user_id, server_id, revision, scope) VALUES (?, ?, 0, ?)', userId, serverId, scope);
      this.db.exec(`INSERT OR IGNORE INTO agent_knowledge_meta (user_id, server_id, key, source, scope, encrypted)
        SELECT user_id, server_id, key, 'legacy', ?, 0 FROM server_knowledge WHERE user_id = ? AND server_id = ?`, scope, userId, serverId);
      state = { revision: 0, scope };
      this.memoryStates.set(key, state);
    } else if (state.scope !== scope) {
      this.db.exec('UPDATE agent_memory_state SET revision = revision + 1, scope = ? WHERE user_id = ? AND server_id = ?', scope, userId, serverId);
      this.db.exec('DELETE FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ?', userId, serverId);
      state = { revision: state.revision + 1, scope };
      this.memoryStates.set(key, state);
    }
    return state;
  }

  private bump(serverId: number, userId: number): void {
    const key = `${userId}:${serverId}`;
    const cur = this.memoryStates.get(key);
    this.db.exec('UPDATE agent_memory_state SET revision = revision + 1 WHERE user_id = ? AND server_id = ?', userId, serverId);
    if (cur) cur.revision++;
  }

  private session(serverId: number, userId: number, value: Record<string, unknown>): void {
    if (typeof value.sessionId !== 'string' || !TASK_ID_PATTERN.test(value.sessionId) ||
      !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) throw new MemoryStoreError(400, 'Invalid session');
    const row = this.query<{ epoch: number }>('SELECT epoch FROM agent_memory_sessions WHERE user_id = ? AND server_id = ? AND session_id = ?', userId, serverId, value.sessionId)[0];
    if (row && row.epoch !== value.epoch) throw new MemoryStoreError(409, 'Stale session');
  }

  async handle(serverId: number, action: string, request: Request, itemId?: number): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const userId = Number(url.searchParams.get('user_id'));
        return action === 'checkpoint' ? await this.getCheckpoint(serverId, userId, url.searchParams.get('task_id'))
          : Response.json(await this.read(serverId, userId));
      }
      if (request.method === 'DELETE' && action !== 'checkpoint' && action !== 'knowledge-batch' && action !== 'pending-distillation') {
        const userId = Number(url.searchParams.get('user_id'));
        return this.remove(serverId, userId, action, itemId!);
      }
      const body = await request.json<Record<string, unknown>>();
      const userId = Number(body.user_id);
      this.state(serverId, userId);
      if (action === 'session') return this.beginSession(serverId, userId, body);
      if (action === 'pending-distillation') {
        if (request.method === 'DELETE') {
          this.session(serverId, userId, body);
          if (typeof body.taskId !== 'string' || !TASK_ID_PATTERN.test(body.taskId)) throw new MemoryStoreError(400, 'Invalid task');
          this.db.exec('DELETE FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, body.taskId);
          return Response.json({ success: true });
        }
        return await this.putPendingDistillation(serverId, userId, body);
      }
      if (action === 'checkpoint') {
        if (request.method === 'DELETE') {
          this.session(serverId, userId, body);
          if (typeof body.taskId !== 'string' || !TASK_ID_PATTERN.test(body.taskId)) throw new MemoryStoreError(400, 'Invalid task');
          this.db.exec('DELETE FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, body.taskId);
          return Response.json({ success: true });
        }
        return await this.putCheckpoint(serverId, userId, body);
      }
      if (action === 'knowledge-batch') {
        const normalized = normalizeBatchDeleteKnowledgeInput(body);
        if (!normalized.ok) throw new MemoryStoreError(400, normalized.error);
        this.transaction(() => {
          for (const id of normalized.value.ids) this.deleteKnowledge(serverId, userId, id);
          this.bump(serverId, userId);
        });
        return Response.json({ success: true, count: normalized.value.ids.length });
      }
      if (action === 'knowledge') return await this.saveKnowledge(serverId, userId, body);
      if (action === 'work-log') return this.saveLog(serverId, userId, body);
      return await this.saveBatch(serverId, userId, body);
    } catch (error) {
      if (error instanceof MemoryStoreError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      // Crypto/SQL failures must never include plaintext or ciphertext in user errors/logs.
      return Response.json({ error: 'Memory storage failed' }, { status: 500 });
    }
  }

  private async read(serverId: number, userId: number, attempt = 0): Promise<UnifiedServerMemory> {
    const state = this.state(serverId, userId);
    const workLogs = this.query<ServerWorkLog>(`SELECT id, user_id, server_id, title, summary, created_at, updated_at
      FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`, serverId, userId, MAX_SERVER_WORK_LOGS);
    const rows = this.query<ServerKnowledgeItem>(`SELECT id, user_id, server_id, category, key, value, created_at, updated_at
      FROM server_knowledge WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`, serverId, userId, MAX_SERVER_KNOWLEDGE);
    const meta = new Map(this.query<MetaRow>('SELECT key, source, scope, encrypted, evidence, task_id, verified_at, expires_at FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ?', userId, serverId).map(row => [row.key, row]));
    const knowledge: ServerKnowledgeItem[] = [];
    for (const row of rows) {
      const info = meta.get(row.key);
      let value = row.value;
      if (info?.encrypted) {
        const payload = storedObject(await this.decrypt(value, userId));
        if (payload.purpose !== 'server-knowledge' || payload.serverId !== serverId || payload.key !== row.key || typeof payload.value !== 'string') {
          throw new MemoryStoreError(500, 'Invalid encrypted memory');
        }
        value = payload.value;
      } else if (row.category === 'credential' || isSensitiveKeyOrValue(row.key, value)) {
        const encrypted = await this.encryptKnowledge(serverId, userId, row.key, value);
        // Encrypt legacy plaintext lazily; recheck after crypto yielded, without changing logical revision.
        if (this.state(serverId, userId).revision !== state.revision) {
          if (attempt) throw new MemoryStoreError(409, 'Memory changed');
          return this.read(serverId, userId, 1);
        }
        this.transaction(() => {
          this.db.exec('UPDATE server_knowledge SET value = ? WHERE id = ? AND user_id = ? AND server_id = ? AND value = ?', encrypted, row.id, userId, serverId, row.value);
          if (info) this.db.exec('UPDATE agent_knowledge_meta SET encrypted = 1 WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, row.key);
          else this.meta(serverId, userId, row.key, 'legacy', state.scope, 1);
        });
      }
      let evidence: string[] | undefined;
      if (info?.evidence) {
        try {
          const parsed: unknown = JSON.parse(info.evidence);
          if (Array.isArray(parsed) && parsed.length <= 256 && parsed.every(item => typeof item === 'string' && item.length <= 80)) evidence = parsed;
        } catch { /* Invalid provenance is not prompt evidence. */ }
      }
      knowledge.push({ ...row, value, source: info?.source ?? 'legacy',
        stale: Boolean(info && (info.scope !== state.scope || (info.expires_at != null && info.expires_at <= Date.now()))),
        ...(evidence ? { evidence } : {}), ...(info?.task_id ? { task_id: info.task_id } : {}),
        ...(info?.verified_at != null ? { verified_at: info.verified_at } : {}),
        ...(info?.expires_at != null ? { expires_at: info.expires_at } : {}) });
    }
    if (this.state(serverId, userId).revision !== state.revision) {
      if (attempt) throw new MemoryStoreError(409, 'Memory changed');
      return this.read(serverId, userId, 1);
    }
    return { workLogs, knowledge, revision: state.revision, scope: state.scope };
  }

  private encryptKnowledge(serverId: number, userId: number, key: string, value: string): Promise<string> {
    return this.encrypt(JSON.stringify({ purpose: 'server-knowledge', serverId, key, value }), userId);
  }

  private meta(serverId: number, userId: number, key: string, source: string, scope: string, encrypted: number,
    proof: KnowledgeProof = {}): void {
    this.db.exec(`INSERT INTO agent_knowledge_meta (user_id, server_id, key, source, scope, encrypted, evidence, task_id, verified_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, server_id, key) DO UPDATE SET
      source = excluded.source, scope = excluded.scope, encrypted = excluded.encrypted, evidence = excluded.evidence,
      task_id = excluded.task_id, verified_at = excluded.verified_at, expires_at = excluded.expires_at`,
      userId, serverId, key, source, scope, encrypted, proof.evidence ? JSON.stringify(proof.evidence) : null,
      proof.taskId ?? null, proof.verifiedAt ?? null, proof.expiresAt ?? null);
  }

  private async prepareKnowledge(serverId: number, userId: number, input: Record<string, unknown>): Promise<NormalizedKnowledge> {
    // Never truncate credentials/values into a different fact.
    const normalized = normalizeKnowledgeInput(input);
    if (!normalized.ok) throw new MemoryStoreError(400, normalized.error);
    const value = normalized.value;
    const encrypted = value.action === 'set' && (value.category === 'credential' || isSensitiveKeyOrValue(value.key, value.value)) ? 1 : 0;
    let evidence: string[] | undefined;
    if (input.evidence !== undefined) {
      if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 256 ||
        !input.evidence.every(item => typeof item === 'string' && item.length > 0 && item.length <= 80)) {
        throw new MemoryStoreError(400, 'Invalid memory evidence');
      }
      evidence = [...new Set(input.evidence as string[])];
    }
    return { ...value, encrypted, evidence,
      ...(encrypted ? { value: await this.encryptKnowledge(serverId, userId, value.key, value.value) } : {}) };
  }

  private writeKnowledge(serverId: number, userId: number, value: NormalizedKnowledge, source: string, scope: string,
    proof: KnowledgeProof = {}): void {
    if (value.action === 'delete') {
      this.db.exec('DELETE FROM server_knowledge WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, value.key);
      try {
        this.db.exec('DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, value.key);
      } catch { /* mock fallback */ }
    } else {
      const now = Date.now();
      this.db.exec(`INSERT INTO server_knowledge (user_id, server_id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, server_id, key) DO UPDATE SET category = excluded.category, value = excluded.value, updated_at = excluded.updated_at`, userId, serverId, value.category, value.key, value.value, now, now);
      const previous = this.query<{ source: string }>('SELECT source FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, value.key)[0];
      const effectiveSource = source === 'agent' && previous?.source === 'user' ? 'user' : source;
      this.meta(serverId, userId, value.key, effectiveSource, scope, value.encrypted,
        effectiveSource === 'user' ? { ...proof, expiresAt: undefined } : proof);
    }
  }

  private trim(serverId: number, userId: number): void {
    this.db.exec(`DELETE FROM server_work_logs WHERE server_id = ? AND user_id = ? AND id NOT IN (
      SELECT id FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`, serverId, userId, serverId, userId, MAX_SERVER_WORK_LOGS);
    this.db.exec(`DELETE FROM server_knowledge WHERE server_id = ? AND user_id = ? AND id NOT IN (
      SELECT id FROM server_knowledge WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`, serverId, userId, serverId, userId, MAX_SERVER_KNOWLEDGE);
    try {
      this.db.exec(`DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key NOT IN (
        SELECT key FROM server_knowledge WHERE user_id = ? AND server_id = ?)`, userId, serverId, userId, serverId);
    } catch { /* mock fallback */ }
  }

  private async saveKnowledge(serverId: number, userId: number, body: Record<string, unknown>): Promise<Response> {
    const value = await this.prepareKnowledge(serverId, userId, body);
    const state = this.state(serverId, userId);
    this.transaction(() => { this.writeKnowledge(serverId, userId, value, 'user', state.scope); this.trim(serverId, userId); this.bump(serverId, userId); });
    const saved = this.query<ServerKnowledgeItem>(
      'SELECT id, user_id, server_id, category, key, value, created_at, updated_at FROM server_knowledge WHERE server_id = ? AND user_id = ? AND key = ?',
      serverId, userId, value.key
    )[0];
    return Response.json(saved ? { ...saved, value: String(body.value ?? saved.value) } : { success: true }, { status: 201 });
  }

  private writeLog(serverId: number, userId: number, log: { title: string; summary: string }, target?: number): void {
    const now = Date.now();
    if (target != null) {
      this.db.exec('UPDATE server_work_logs SET title = ?, summary = ?, updated_at = ? WHERE id = ? AND user_id = ? AND server_id = ?', log.title, log.summary, now, target, userId, serverId);
    } else {
      this.db.exec('INSERT INTO server_work_logs (user_id, server_id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', userId, serverId, log.title, log.summary, now, now);
    }
  }

  private saveLog(serverId: number, userId: number, body: Record<string, unknown>): Response {
    const normalized = normalizeWorkLogInput(body);
    if (!normalized.ok) throw new MemoryStoreError(400, normalized.error);
    this.transaction(() => { this.writeLog(serverId, userId, normalized.value); this.trim(serverId, userId); this.bump(serverId, userId); });
    const saved = this.query<ServerWorkLog>(
      'SELECT id, user_id, server_id, title, summary, created_at, updated_at FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1',
      serverId, userId
    );
    return Response.json(saved[0] ?? { success: true }, { status: 201 });
  }

  private deleteKnowledge(serverId: number, userId: number, id: number): void {
    const row = this.query<{ key: string }>('SELECT key FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?', id, serverId, userId)[0];
    this.db.exec('DELETE FROM server_knowledge WHERE id = ? AND server_id = ? AND user_id = ?', id, serverId, userId);
    if (row) this.db.exec('DELETE FROM agent_knowledge_meta WHERE user_id = ? AND server_id = ? AND key = ?', userId, serverId, row.key);
  }

  private remove(serverId: number, userId: number, action: string, id: number): Response {
    this.state(serverId, userId);
    const sql = action === 'work-log'
      ? 'SELECT user_id FROM server_work_logs WHERE id = ? AND server_id = ?'
      : 'SELECT user_id FROM server_knowledge WHERE id = ? AND server_id = ?';
    const rows = this.query<{ user_id: number }>(sql, id, serverId);
    if (!rows.length) {
      throw new MemoryStoreError(404, 'Memory not found');
    }
    if (rows[0].user_id !== userId) {
      throw new MemoryStoreError(403, 'Forbidden');
    }
    this.transaction(() => {
      if (action === 'work-log') this.db.exec('DELETE FROM server_work_logs WHERE id = ? AND server_id = ? AND user_id = ?', id, serverId, userId);
      else this.deleteKnowledge(serverId, userId, id);
      this.trim(serverId, userId);
      this.bump(serverId, userId);
    });
    return Response.json({ success: true });
  }

  private async saveBatch(serverId: number, userId: number, body: Record<string, unknown>): Promise<Response> {
    if (typeof body.sessionId === 'string') {
      this.session(serverId, userId, body);
    }
    if (body.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) throw new MemoryStoreError(400, 'Missing memory revision');
    }
    const raw = body.knowledge ?? [];
    if (!Array.isArray(raw) || raw.length > 100) throw new MemoryStoreError(400, 'Invalid knowledge batch');
    const knowledge: NormalizedKnowledge[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new MemoryStoreError(400, 'Invalid knowledge');
      const value = await this.prepareKnowledge(serverId, userId, item);
      if (knowledge.some(entry => entry.key === value.key)) throw new MemoryStoreError(400, 'Duplicate knowledge key');
      knowledge.push(value);
    }
    const rawLogs = Array.isArray(body.workLogs)
      ? body.workLogs
      : body.workLog
        ? [body.workLog]
        : [];
    if (rawLogs.length > MAX_SERVER_WORK_LOGS) throw new MemoryStoreError(400, 'Too many work logs');
    const logs = rawLogs.map(rawLog => {
      const log = normalizeWorkLogInput(rawLog as Record<string, unknown>, { truncate: true });
      if (!log.ok) throw new MemoryStoreError(400, log.error);
      return log.value;
    });
    const state = this.state(serverId, userId);
    const nextRevision = state.revision + 1;
    // No await between final revision/session/ownership checks and all writes.
    return this.transaction(() => {
      if (typeof body.sessionId === 'string') {
        this.session(serverId, userId, body);
      }
      if (body.expectedRevision !== undefined && state.revision !== body.expectedRevision) {
        throw new MemoryStoreError(409, 'Memory changed', 'memory_revision_conflict');
      }
      for (const value of knowledge) {
        const hasProof = value.action === 'set' && value.evidence?.length && typeof body.taskId === 'string' && TASK_ID_PATTERN.test(body.taskId);
        const now = Date.now();
        this.writeKnowledge(serverId, userId, value, 'agent', state.scope, hasProof ? {
          evidence: value.evidence, taskId: body.taskId as string, verifiedAt: now,
          ...(['config', 'note'].includes(value.category) ? { expiresAt: now + AGENT_KNOWLEDGE_TTL_MS } : {}),
        } : {});
      }
      for (const log of logs) {
        let target: number | undefined;
        if (log.mode === 'update_latest') {
          if (typeof body.targetLogId === 'number') {
            const existing = this.query<ServerWorkLog>('SELECT id, updated_at FROM server_work_logs WHERE id = ? AND user_id = ? AND server_id = ?', body.targetLogId, userId, serverId)[0];
            if (existing && Date.now() - existing.updated_at <= CONSECUTIVE_TASK_WINDOW_MS) target = existing.id;
          } else {
            const latest = this.query<ServerWorkLog>('SELECT id FROM server_work_logs WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1', serverId, userId)[0];
            if (latest) target = latest.id;
          }
        }
        this.writeLog(serverId, userId, log, target);
      }
      this.trim(serverId, userId);
      this.bump(serverId, userId);
      return Response.json({ success: true, revision: nextRevision });
    });
  }

  private async putPendingDistillation(serverId: number, userId: number, body: Record<string, unknown>): Promise<Response> {
    this.session(serverId, userId, body);
    const taskId = body.taskId;
    const retries = Number(body.retries ?? 0);
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId) || !Number.isSafeInteger(retries) || retries < 0) {
      throw new MemoryStoreError(400, 'Invalid pending distillation');
    }
    const scope = this.state(serverId, userId).scope;
    const payload = await this.encrypt(JSON.stringify({ purpose: 'pending-distillation', serverId, scope, job: body.job }), userId);
    return this.transaction(() => {
      this.session(serverId, userId, body);
      if (this.state(serverId, userId).scope !== scope) throw new MemoryStoreError(409, 'Server route changed');
      const now = Date.now();
      this.db.exec(`INSERT INTO agent_pending_distillations (user_id, server_id, task_id, session_id, epoch, retries, payload_enc, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, server_id, task_id) DO UPDATE SET
        session_id = excluded.session_id, epoch = excluded.epoch, retries = excluded.retries,
        payload_enc = excluded.payload_enc, updated_at = excluded.updated_at`,
        userId, serverId, taskId, body.sessionId as string, body.epoch as number, retries, payload, now);
      this.db.exec('DELETE FROM agent_pending_distillations WHERE user_id = ? AND server_id = ? AND (retries > 3 OR updated_at < ?)',
        userId, serverId, now - 24 * 60 * 60 * 1000);
      return Response.json({ success: true });
    });
  }

  private beginSession(serverId: number, userId: number, body: Record<string, unknown>): Response {
    if (typeof body.sessionId !== 'string' || !TASK_ID_PATTERN.test(body.sessionId) ||
      !Number.isSafeInteger(body.epoch) || (body.epoch as number) < 0) throw new MemoryStoreError(400, 'Invalid session');
    const existing = this.query<{ epoch: number }>('SELECT epoch FROM agent_memory_sessions WHERE user_id = ? AND server_id = ? AND session_id = ?', userId, serverId, body.sessionId)[0];
    if (existing && existing.epoch > (body.epoch as number)) throw new MemoryStoreError(409, 'Stale session');
    this.transaction(() => {
      this.db.exec(`INSERT INTO agent_memory_sessions (user_id, server_id, session_id, epoch, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, server_id, session_id) DO UPDATE SET epoch = excluded.epoch, updated_at = excluded.updated_at`, userId, serverId, body.sessionId as string, body.epoch as number, Date.now());
      this.db.exec('DELETE FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ? AND session_id = ? AND epoch < ?', userId, serverId, body.sessionId as string, body.epoch as number);
      this.db.exec('DELETE FROM agent_task_checkpoints WHERE expires_at <= ?', Date.now());
      this.db.exec(`DELETE FROM agent_memory_sessions WHERE user_id = ? AND server_id = ? AND session_id NOT IN (
        SELECT session_id FROM agent_memory_sessions WHERE user_id = ? AND server_id = ? ORDER BY updated_at DESC LIMIT 64)`, userId, serverId, userId, serverId);
    });
    return Response.json({ success: true });
  }

  private async putCheckpoint(serverId: number, userId: number, body: Record<string, unknown>): Promise<Response> {
    this.session(serverId, userId, body);
    const checkpoint = body.checkpoint;
    if (!validTaskCheckpoint(checkpoint)) throw new MemoryStoreError(400, 'Invalid checkpoint');
    const scope = this.state(serverId, userId).scope;
    const payload = await this.encrypt(JSON.stringify({ purpose: 'agent-checkpoint', serverId, scope, checkpoint }), userId);
    return this.transaction(() => {
      this.session(serverId, userId, body);
      if (this.state(serverId, userId).scope !== scope) throw new MemoryStoreError(409, 'Server route changed');
      const existing = this.query<{ step: number; updated_at: number }>('SELECT step, updated_at FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, checkpoint.taskId)[0];
      if (existing && (existing.step > checkpoint.step || existing.updated_at > checkpoint.updatedAt)) throw new MemoryStoreError(409, 'Stale checkpoint');
      const now = Date.now();
      this.db.exec(`INSERT INTO agent_task_checkpoints (user_id, server_id, task_id, session_id, epoch, scope, payload_enc, step, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, server_id, task_id) DO UPDATE SET
        session_id = excluded.session_id, epoch = excluded.epoch, scope = excluded.scope, payload_enc = excluded.payload_enc,
        step = excluded.step, expires_at = excluded.expires_at, updated_at = excluded.updated_at`, userId, serverId, checkpoint.taskId,
        body.sessionId as string, body.epoch as number, scope, payload, checkpoint.step, now + TASK_CHECKPOINT_TTL_MS, checkpoint.updatedAt);
      this.db.exec(`DELETE FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ? AND task_id NOT IN (
        SELECT task_id FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ? ORDER BY updated_at DESC LIMIT ?)`, userId, serverId, userId, serverId, TASK_CHECKPOINT_MAX_COUNT);
      return Response.json({ success: true });
    });
  }

  private async getCheckpoint(serverId: number, userId: number, taskId: string | null): Promise<Response> {
    const state = this.state(serverId, userId);
    if (!taskId || !TASK_ID_PATTERN.test(taskId)) throw new MemoryStoreError(400, 'Invalid task');
    const row = this.query<{ payload_enc: string; scope: string; expires_at: number }>(
      'SELECT payload_enc, scope, expires_at FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, taskId)[0];
    if (!row || row.expires_at <= Date.now() || row.scope !== state.scope) throw new MemoryStoreError(404, 'Checkpoint unavailable');
    const payload = storedObject(await this.decrypt(row.payload_enc, userId));
    if (payload.purpose !== 'agent-checkpoint' || payload.serverId !== serverId || payload.scope !== state.scope ||
      !validTaskCheckpoint(payload.checkpoint) || payload.checkpoint.taskId !== taskId ||
      this.state(serverId, userId).scope !== state.scope || row.expires_at <= Date.now()) throw new MemoryStoreError(409, 'Checkpoint changed');
    // Reject a reset/deletion that raced decryption.
    const current = this.query<{ payload_enc: string }>('SELECT payload_enc FROM agent_task_checkpoints WHERE user_id = ? AND server_id = ? AND task_id = ?', userId, serverId, taskId)[0];
    if (current?.payload_enc !== row.payload_enc) throw new MemoryStoreError(409, 'Checkpoint changed');
    return Response.json(payload.checkpoint);
  }

  cleanup(serverId: number): void {
    try {
      this.db.exec('DELETE FROM agent_memory_state WHERE server_id = ?', serverId);
      this.db.exec('DELETE FROM agent_knowledge_meta WHERE server_id = ?', serverId);
      this.db.exec('DELETE FROM agent_memory_sessions WHERE server_id = ?', serverId);
      this.db.exec('DELETE FROM agent_task_checkpoints WHERE server_id = ?', serverId);
      this.db.exec('DELETE FROM agent_pending_distillations WHERE server_id = ?', serverId);
    } catch { /* mock fallback */ }
  }
}
