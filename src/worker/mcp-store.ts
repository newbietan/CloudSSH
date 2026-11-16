import {
  mcpHash,
  mcpTokenRoute,
  parseMcpTokenInput,
  type McpActivity,
  type McpPrincipal,
  type McpTokenInfo,
} from '../mcp-schema';

type SQL = { exec(query: string, ...values: unknown[]): { toArray(): Record<string, unknown>[] } };
type TokenRow = {
  id: string;
  user_id: number;
  name: string;
  server_ids: string;
  scopes: string;
  expires_at: number;
  created_at: number;
  route_key: string;
  mode_tag: string;
};

/** Per-owner storage. No command, path, credentials or command output in activity rows. */
export class McpStore {
  constructor(private sql: SQL) {
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL,
      name TEXT NOT NULL, server_ids TEXT NOT NULL, scopes TEXT NOT NULL, route_key TEXT NOT NULL,
      mode_tag TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      window_start INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_activity (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, client TEXT NOT NULL, server_id INTEGER NOT NULL,
      tool TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER)`);
  }
  private info(row: TokenRow): McpTokenInfo {
    return {
      id: row.id,
      name: row.name,
      serverIds: JSON.parse(row.server_ids),
      scopes: JSON.parse(row.scopes),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
  list(userId: number): McpTokenInfo[] {
    this.sql.exec('DELETE FROM mcp_tokens WHERE expires_at <= ?', Date.now());
    return (
      this.sql
        .exec('SELECT * FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC', userId)
        .toArray() as unknown as TokenRow[]
    ).map((row) => this.info(row));
  }
  async create(userId: number, routeKey: string, modeTag: string, input: unknown) {
    const value = parseMcpTokenInput(input);
    if (this.list(userId).length >= 20) throw new Error('token_limit');
    for (const id of value.serverIds) {
      if (
        !this.sql.exec('SELECT id FROM servers WHERE id = ? AND user_id = ?', id, userId).toArray()
          .length
      )
        throw new Error('server_not_found');
    }
    const secret = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const token = `mcp_${routeKey}:${secret}`;
    if (!mcpTokenRoute(token)) throw new Error('invalid_identity');
    const info: McpTokenInfo = {
      id: crypto.randomUUID(),
      name: value.name,
      serverIds: value.serverIds,
      scopes: value.scopes,
      expiresAt: Date.now() + value.days * 86_400_000,
      createdAt: Date.now(),
    };
    const digest = await mcpHash(token);
    // Recheck after the hash await so concurrent creation cannot exceed the cap.
    if (this.list(userId).length >= 20) throw new Error('token_limit');
    this.sql.exec(
      `INSERT INTO mcp_tokens (id, token_hash, user_id, name, server_ids, scopes, route_key,
      mode_tag, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      info.id,
      digest,
      userId,
      info.name,
      JSON.stringify(info.serverIds),
      JSON.stringify(info.scopes),
      routeKey,
      modeTag,
      info.expiresAt,
      info.createdAt
    );
    return { ...info, token };
  }
  async verify(token: string, modeTag: string): Promise<McpPrincipal | null> {
    const routeKey = mcpTokenRoute(token);
    if (!routeKey) return null;
    const row = this.sql
      .exec(
        'SELECT * FROM mcp_tokens WHERE token_hash = ? AND expires_at > ?',
        await mcpHash(token),
        Date.now()
      )
      .toArray()[0] as unknown as TokenRow | undefined;
    if (!row || row.route_key !== routeKey || row.mode_tag !== modeTag) return null;
    return { ...this.info(row), userId: row.user_id, routeKey, modeTag };
  }
  consumeRequest(id: string): boolean {
    const row = this.sql
      .exec('SELECT window_start, request_count FROM mcp_tokens WHERE id = ?', id)
      .toArray()[0];
    if (!row) return false;
    const fresh = Date.now() - Number(row.window_start) >= 60_000;
    if (!fresh && Number(row.request_count) >= 120) return false;
    this.sql.exec(
      'UPDATE mcp_tokens SET window_start = ?, request_count = ? WHERE id = ?',
      fresh ? Date.now() : row.window_start,
      fresh ? 1 : Number(row.request_count) + 1,
      id
    );
    return true;
  }
  revoke(id: string, userId: number): void {
    this.sql.exec('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?', id, userId);
  }
  cleanup(): number | null {
    this.sql.exec('DELETE FROM mcp_activity WHERE started_at <= ?', Date.now() - 86_400_000);
    this.sql.exec('DELETE FROM mcp_tokens WHERE expires_at <= ?', Date.now());
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at
      WHERE mcp_activity.user_id = excluded.user_id AND mcp_activity.status = 'running'`,
      activity.id,
      userId,
      activity.client,
      activity.serverId,
      activity.tool,
      activity.status,
      activity.startedAt,
      activity.finishedAt
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
