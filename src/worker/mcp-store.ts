import {
  mcpHash,
  mcpTokenRoute,
  parseMcpConfigInput,
  type McpActivity,
  type McpConfigInfo,
  type McpGrant,
  type McpPrincipal,
  type McpSavedCredentials,
} from '../mcp-schema';
type SQL = { exec(query: string, ...values: unknown[]): { toArray(): Record<string, unknown>[] } };
type ConfigRow = {
  user_id: number;
  id: string;
  route_key: string;
  mode_tag: string;
  token_hash: string;
  credentials_enc: string;
  grants: string;
  has_access: number;
  created_at: number;
};
type Crypt = (value: string, userId: number) => Promise<string>;

/** One encrypted configuration per owner; operation summaries never contain payloads. */
export class McpStore {
  private creating = new Map<number, Promise<McpConfigInfo>>();
  private updating = false;
  constructor(
    private sql: SQL,
    private encrypt: Crypt,
    private decrypt: Crypt
  ) {
    // Legacy digests cannot be recovered. They are never accepted by the new verifier.
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL,
      name TEXT NOT NULL, server_ids TEXT NOT NULL, scopes TEXT NOT NULL, route_key TEXT NOT NULL,
      mode_tag TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      window_start INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_configs (
      user_id INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, route_key TEXT NOT NULL, mode_tag TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL, credentials_enc TEXT NOT NULL, grants TEXT NOT NULL,
      has_access INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      window_start INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_activity (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, client TEXT NOT NULL, server_id INTEGER NOT NULL,
      tool TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER)`);
    // Older versions filtered deleted servers on read, but never removed the stored references.
    this.pruneMissingServers();
  }

  /** Idempotent on cold start; on DELETE run inside the server transaction, for that owner only. */
  pruneMissingServers(userId?: number): void {
    const owner = userId === undefined ? '' : 'user_id = ? AND ';
    const params = userId === undefined ? [] : [userId];
    for (const [table, column, id, value] of [
      ['mcp_configs', 'grants', "CASE WHEN entry.type = 'object' THEN json_extract(entry.value, '$.serverId') END", 'json(entry.value)'],
      ['mcp_tokens', 'server_ids', "CASE WHEN entry.type = 'integer' THEN entry.value END", 'entry.value'],
    ]) {
      // All identifiers/expressions above are fixed. Keep other grants, token bindings and
      // encrypted credentials byte-for-byte untouched; an empty grant array is valid.
      // A damaged historic row must not stop the whole UserDB from opening. Never infer
      // access from a non-array; json_each(NULL) has no rows.
      const array = `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} END END`;
      const entries = `json_each(${array}) entry`;
      const live = `EXISTS (SELECT 1 FROM servers s WHERE s.id = ${id} AND s.user_id = ${table}.user_id)`;
      this.sql.exec(`UPDATE ${table} SET ${column} = (
        SELECT json_group_array(${value}) FROM ${entries} WHERE ${live})
        WHERE ${owner}(${array} IS NULL OR EXISTS (SELECT 1 FROM ${entries} WHERE NOT ${live}))`, ...params);
    }
    this.sql.exec(`DELETE FROM mcp_activity WHERE ${owner}NOT EXISTS (
      SELECT 1 FROM servers s WHERE s.id = mcp_activity.server_id AND s.user_id = mcp_activity.user_id)`, ...params);
  }

  executionPool(userId: number): Pick<McpPrincipal, 'id' | 'routeKey'> | null {
    const row = this.sql.exec('SELECT id, route_key FROM mcp_configs WHERE user_id = ?', userId).toArray()[0];
    return row ? { id: String(row.id), routeKey: String(row.route_key) } : null;
  }

  private row(userId: number): ConfigRow | undefined {
    return this.sql
      .exec('SELECT * FROM mcp_configs WHERE user_id = ?', userId)
      .toArray()[0] as unknown as ConfigRow | undefined;
  }
  private owned(grants: McpGrant[], userId: number): void {
    for (const grant of grants)
      if (
        !this.sql
          .exec('SELECT id FROM servers WHERE id = ? AND user_id = ?', grant.serverId, userId)
          .toArray().length
      )
        throw new Error('server_not_found');
  }
  get(userId: number, routeKey: string, _modeTag: string): McpConfigInfo {
    const row = this.row(userId);
    if (!row)
      return {
        configured: false,
        id: null,
        grants: [],
        hasAccessCredentials: false,
        legacy:
          this.sql.exec('SELECT id FROM mcp_tokens WHERE user_id = ? LIMIT 1', userId).toArray()
            .length > 0,
      };
    if (row.route_key !== routeKey) throw new Error('invalid_identity');
    const grants = (JSON.parse(row.grants) as McpGrant[]).filter(
      (grant) =>
        this.sql
          .exec('SELECT id FROM servers WHERE id = ? AND user_id = ?', grant.serverId, userId)
          .toArray().length > 0
    );
    return {
      configured: true,
      id: row.id,
      grants,
      hasAccessCredentials: !!row.has_access,
      legacy: false,
    };
  }
  async create(
    userId: number,
    routeKey: string,
    modeTag: string,
    input: unknown
  ): Promise<McpConfigInfo> {
    if (this.row(userId)) return this.get(userId, routeKey, modeTag);
    const pending = this.creating.get(userId);
    if (pending) {
      await pending;
      return this.get(userId, routeKey, modeTag);
    }
    const task = this.createOnce(userId, routeKey, modeTag, input);
    this.creating.set(userId, task);
    try {
      return await task;
    } finally {
      this.creating.delete(userId);
    }
  }
  private async createOnce(
    userId: number,
    routeKey: string,
    modeTag: string,
    input: unknown
  ): Promise<McpConfigInfo> {
    const value = parseMcpConfigInput(input);
    this.owned(value.grants, userId);
    if (modeTag === 'cf_access' && !value.access) throw new Error('access_required');
    if (modeTag !== 'cf_access' && value.access) throw new Error('invalid_access');
    const secret = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const token = 'mcp_' + routeKey + ':' + secret;
    if (!mcpTokenRoute(token)) throw new Error('invalid_identity');
    const credentials: McpSavedCredentials = {
      token,
      ...(value.access ? { access: value.access } : {}),
    };
    const [digest, encrypted] = await Promise.all([
      mcpHash(token),
      this.encrypt(JSON.stringify(credentials), userId),
    ]);
    this.owned(value.grants, userId);
    this.sql.exec(
      `INSERT INTO mcp_configs (user_id, id, route_key, mode_tag, token_hash, credentials_enc, grants, has_access, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      crypto.randomUUID(),
      routeKey,
      modeTag,
      digest,
      encrypted,
      JSON.stringify(value.grants),
      value.access ? 1 : 0,
      Date.now()
    );
    this.sql.exec('DELETE FROM mcp_tokens WHERE user_id = ?', userId);
    return this.get(userId, routeKey, modeTag);
  }
  async update(
    userId: number,
    routeKey: string,
    modeTag: string,
    input: unknown
  ): Promise<McpConfigInfo> {
    if (this.updating) throw new Error('busy');
    this.updating = true;
    try {
      const value = parseMcpConfigInput(input);
      const info = this.get(userId, routeKey, modeTag);
      const row = this.row(userId);
      if (!row) throw new Error('not_configured');
      this.owned(value.grants, userId);
      if (modeTag === 'cf_access' && !info.hasAccessCredentials && !value.access)
        throw new Error('access_required');
      if (modeTag !== 'cf_access' && value.access) throw new Error('invalid_access');
      let encrypted = row.credentials_enc;
      if (value.access) {
        const credentials = JSON.parse(
          await this.decrypt(encrypted, userId)
        ) as McpSavedCredentials;
        encrypted = await this.encrypt(
          JSON.stringify({ token: credentials.token, access: value.access }),
          userId
        );
      }
      this.owned(value.grants, userId);
      this.sql.exec(
        'UPDATE mcp_configs SET grants = ?, credentials_enc = ?, has_access = ?, mode_tag = ? WHERE user_id = ?',
        JSON.stringify(value.grants),
        encrypted,
        value.access ? 1 : row.has_access,
        modeTag,
        userId
      );
      return this.get(userId, routeKey, modeTag);
    } finally {
      this.updating = false;
    }
  }
  async credentials(
    userId: number,
    routeKey: string,
    modeTag: string
  ): Promise<McpSavedCredentials> {
    this.get(userId, routeKey, modeTag);
    const row = this.row(userId);
    if (!row) throw new Error('not_configured');
    const value = JSON.parse(
      await this.decrypt(row.credentials_enc, userId)
    ) as McpSavedCredentials;
    // Explicit authenticated POST copy/view can rebind after password rotation; GET never mutates.
    if (row.mode_tag !== modeTag)
      this.sql.exec('UPDATE mcp_configs SET mode_tag = ? WHERE user_id = ?', modeTag, userId);
    return {
      token: value.token,
      ...(modeTag === 'cf_access' && value.access ? { access: value.access } : {}),
    };
  }
  async verify(token: string, modeTag: string): Promise<McpPrincipal | null> {
    const routeKey = mcpTokenRoute(token);
    if (!routeKey) return null;
    const row = this.sql
      .exec('SELECT * FROM mcp_configs WHERE token_hash = ?', await mcpHash(token))
      .toArray()[0] as unknown as ConfigRow | undefined;
    if (!row || row.route_key !== routeKey || row.mode_tag !== modeTag) return null;
    const grants = (JSON.parse(row.grants) as McpGrant[]).filter(
      (grant) =>
        this.sql
          .exec('SELECT id FROM servers WHERE id = ? AND user_id = ?', grant.serverId, row.user_id)
          .toArray().length > 0
    );
    return {
      id: row.id,
      userId: row.user_id,
      routeKey,
      modeTag,
      grants,
      serverIds: grants.map((g) => g.serverId),
      scopes: [...new Set(grants.flatMap((g) => g.scopes))],
      name: 'MCP',
      expiresAt: Number.MAX_SAFE_INTEGER,
      createdAt: row.created_at,
    };
  }
  consumeRequest(id: string): boolean {
    const row = this.sql
      .exec('SELECT window_start, request_count FROM mcp_configs WHERE id = ?', id)
      .toArray()[0];
    if (!row) return false;
    const fresh = Date.now() - Number(row.window_start) >= 60_000;
    if (!fresh && Number(row.request_count) >= 120) return false;
    this.sql.exec(
      'UPDATE mcp_configs SET window_start = ?, request_count = ? WHERE id = ?',
      fresh ? Date.now() : row.window_start,
      fresh ? 1 : Number(row.request_count) + 1,
      id
    );
    return true;
  }
  cleanup(): number | null {
    this.sql.exec('DELETE FROM mcp_activity WHERE started_at <= ?', Date.now() - 86_400_000);
    const row = this.sql.exec('SELECT MIN(started_at) AS oldest FROM mcp_activity').toArray()[0];
    return row?.oldest == null ? null : Number(row.oldest) + 86_400_000;
  }
  activity(userId: number): McpActivity[] {
    this.cleanup();
    return this.sql
      .exec(
        'SELECT * FROM mcp_activity WHERE user_id = ? ORDER BY started_at DESC LIMIT 100',
        userId
      )
      .toArray()
      .map((row) => ({
        id: String(row.id),
        client: String(row.client),
        serverId: Number(row.server_id),
        tool: String(row.tool),
        status:
          row.status === 'running' && Number(row.started_at) < Date.now() - 120_000
            ? 'unknown'
            : (row.status as McpActivity['status']),
        startedAt: Number(row.started_at),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      }));
  }
  record(userId: number, activity: McpActivity): void {
    this.sql.exec(
      `INSERT INTO mcp_activity (id, user_id, client, server_id, tool, status, started_at, finished_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM servers WHERE id = ? AND user_id = ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at
      WHERE mcp_activity.user_id = excluded.user_id AND mcp_activity.server_id = excluded.server_id
      AND mcp_activity.status = 'running'`,
      activity.id,
      userId,
      activity.client,
      activity.serverId,
      activity.tool,
      activity.status,
      activity.startedAt,
      activity.finishedAt,
      activity.serverId,
      userId
    );
    this.sql.exec(
      `DELETE FROM mcp_activity WHERE user_id = ? AND id NOT IN
      (SELECT id FROM mcp_activity WHERE user_id = ? ORDER BY started_at DESC LIMIT 100)`,
      userId,
      userId
    );
    this.cleanup();
  }
}
