import { Env, UserInfo, ServerConfig, SSHConnectionConfig, SSHJumpHostConfig, ALLOWED_LOCATION_HINTS } from '../types';
import { inferLocationHint, type InferResult } from './ip-geo';
import { deserializeServerRow, serializeServerTags } from './server-tags';
import { isDetectedOS } from './os-detect';

const AUTH_METHODS = new Set(['password', 'publickey']);
const MAX_JUMP_HOSTS = 3;

interface StoredServerRow {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  credential: string;
  auth_method: string;
  region: string | null;
  inferred_hint: string | null;
  os: string | null;
  jump_server_id: number | null;
}

/**
 * UserDBDO — 按 GitHub 用户 ID 命名并隔离的用户数据库 Durable Object
 *
 * 职责：
 * - 用户管理（GitHub OAuth 登录后创建/更新）
 * - Session 管理（创建/验证/清除）
 * - 服务器配置 CRUD（含 AES-256-GCM 凭据加密）
 * - One-time-token 生成与消费（安全传递凭据）
 */
export class UserDBDO {
  private state: DurableObjectState;
  private env: Env;
  private db: any; // SqlStorage (DO SQLite)
  // one-time-token 内存存储：token → { config, expiresAt }
  private connectTokens: Map<string, { config: SSHConnectionConfig; expiresAt: number }> = new Map();
  private static readonly MAX_CONNECT_TOKENS = 1000;
  private derivedKeyCache: Map<number, CryptoKey> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.db = (state.storage as any).sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        github_id   INTEGER UNIQUE NOT NULL,
        username    TEXT NOT NULL,
        avatar_url  TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        expires_at  TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS servers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        name        TEXT NOT NULL,
        host        TEXT NOT NULL,
        port        INTEGER DEFAULT 22,
        username    TEXT NOT NULL,
        credential  TEXT NOT NULL,
        auth_method TEXT DEFAULT 'password',
        region      TEXT DEFAULT NULL,
        inferred_hint TEXT DEFAULT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        os          TEXT DEFAULT NULL,
        jump_server_id INTEGER DEFAULT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_servers_user ON servers(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS user_themes (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id),
        theme_data  TEXT NOT NULL,
        updated_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS known_hosts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        host        TEXT NOT NULL,
        port        INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, host, port)
      );

      CREATE INDEX IF NOT EXISTS idx_known_hosts_user ON known_hosts(user_id);

      CREATE TABLE IF NOT EXISTS ai_configs (
        user_id        INTEGER PRIMARY KEY REFERENCES users(id),
        base_url       TEXT NOT NULL,
        model          TEXT NOT NULL,
        api_key_enc    TEXT NOT NULL,
        api_key_last4  TEXT,
        updated_at     TEXT DEFAULT (datetime('now'))
      );
    `);

    // === Migration: 给既有 servers 表追加 region / inferred_hint 列（幂等） ===
    // SQLite 没有 ADD COLUMN IF NOT EXISTS，用 PRAGMA table_info 守卫
    const serverCols = this.db.exec("PRAGMA table_info(servers)").toArray();
    if (!serverCols.some((c: any) => c.name === 'region')) {
      this.db.exec("ALTER TABLE servers ADD COLUMN region TEXT DEFAULT NULL");
    }
    if (!serverCols.some((c: any) => c.name === 'inferred_hint')) {
      this.db.exec("ALTER TABLE servers ADD COLUMN inferred_hint TEXT DEFAULT NULL");
    }
    if (!serverCols.some((c: any) => c.name === 'tags')) {
      this.db.exec("ALTER TABLE servers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    if (!serverCols.some((c: any) => c.name === 'os')) {
      this.db.exec("ALTER TABLE servers ADD COLUMN os TEXT DEFAULT NULL");
    }
    if (!serverCols.some((c: any) => c.name === 'jump_server_id')) {
      this.db.exec("ALTER TABLE servers ADD COLUMN jump_server_id INTEGER DEFAULT NULL");
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_servers_jump ON servers(jump_server_id)');
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- 用户管理 ---
      if (path === '/internal/oauth-user' && request.method === 'POST') {
        return this.handleOAuthUser(request);
      }

      // --- Session 管理 ---
      if (path === '/internal/session/create' && request.method === 'POST') {
        return this.handleSessionCreate(request);
      }
      if (path === '/internal/session/verify' && request.method === 'POST') {
        return this.handleSessionVerify(request);
      }
      if (path === '/internal/session/delete' && request.method === 'POST') {
        return this.handleSessionDelete(request);
      }

      // --- 服务器 CRUD ---
      if (path === '/internal/servers' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetServers(userId);
      }
      if (path === '/internal/servers' && request.method === 'POST') {
        return this.handleAddServer(request);
      }

      // /internal/servers/:id
      const serverMatch = path.match(/^\/internal\/servers\/(\d+)$/);
      if (serverMatch) {
        const serverId = parseInt(serverMatch[1]);
        if (request.method === 'PUT') return this.handleUpdateServer(serverId, request);
        if (request.method === 'DELETE') return this.handleDeleteServer(serverId, request);
      }

      // /internal/servers/:id/connect
      const connectMatch = path.match(/^\/internal\/servers\/(\d+)\/connect$/);
      if (connectMatch && request.method === 'POST') {
        return this.handleConnectServer(parseInt(connectMatch[1]), request);
      }

      // /internal/servers/:id/os —— 仅由 SSHSession（可信会话）通过 DO stub 调用
      const osMatch = path.match(/^\/internal\/servers\/(\d+)\/os$/);
      if (osMatch && request.method === 'PUT') {
        return this.handleUpdateServerOS(parseInt(osMatch[1]), request);
      }

      // --- 用户自定义主题 ---
      if (path === '/internal/theme' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetTheme(userId);
      }
      if (path === '/internal/theme' && request.method === 'PUT') {
        return this.handlePutTheme(request);
      }
      // --- One-time-token 消费 ---
      if (path === '/internal/connect-token/consume' && request.method === 'POST') {
        return this.handleConsumeToken(request);
      }

      // --- known_hosts 管理 ---
      if (path === '/internal/known-hosts' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetKnownHosts(userId, url.searchParams.get('host'), url.searchParams.get('port'));
      }
      if (path === '/internal/known-hosts' && request.method === 'POST') {
        return this.handleUpsertKnownHost(request);
      }
      if (path === '/internal/known-hosts' && request.method === 'DELETE') {
        return this.handleDeleteKnownHost(request);
      }

      // --- AI 配置管理 ---
      if (path === '/internal/ai-config' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetAIConfig(userId);
      }
      if (path === '/internal/ai-config' && request.method === 'PUT') {
        return this.handlePutAIConfig(request);
      }
      if (path === '/internal/ai-config/decrypt' && request.method === 'GET') {
        const userIdStr = url.searchParams.get('user_id');
        if (!userIdStr) return Response.json({ error: 'Missing user_id' }, { status: 400 });
        const userId = parseInt(userIdStr);
        if (isNaN(userId)) return Response.json({ error: 'Invalid user_id' }, { status: 400 });
        return this.handleGetAIConfigDecrypted(userId);
      }

      return Response.json({ error: 'Not Found' }, { status: 404 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[UserDB] Unhandled error:', msg);
      return Response.json({ error: '服务器内部错误' }, { status: 500 });
    }
  }

  // ==================== 用户管理 ====================

  private async handleOAuthUser(request: Request): Promise<Response> {
    const { github_id, username, avatar_url } = await request.json<{
      github_id: number;
      username: string;
      avatar_url: string;
    }>();

    // Upsert 用户
    const existing = this.db
      .exec('SELECT id, github_id, username, avatar_url FROM users WHERE github_id = ?', github_id)
      .toArray();

    if (existing.length > 0) {
      // 更新用户信息
      this.db.exec(
        "UPDATE users SET username = ?, avatar_url = ?, updated_at = datetime('now') WHERE github_id = ?",
        username,
        avatar_url,
        github_id
      );
      const user = existing[0] as unknown as UserInfo;
      user.username = username;
      user.avatar_url = avatar_url;
      return Response.json(user);
    }

    // 新建用户
    this.db.exec(
      'INSERT INTO users (github_id, username, avatar_url) VALUES (?, ?, ?)',
      github_id,
      username,
      avatar_url
    );

    const newUser = this.db
      .exec('SELECT id, github_id, username, avatar_url FROM users WHERE github_id = ?', github_id)
      .toArray()[0] as unknown as UserInfo;

    return Response.json(newUser);
  }

  // ==================== Session 管理 ====================

  private async handleSessionCreate(request: Request): Promise<Response> {
    const { user_id } = await request.json<{ user_id: number }>();

    // 获取 github_id
    const userRows = this.db.exec('SELECT github_id FROM users WHERE id = ?', user_id).toArray();
    if (userRows.length === 0) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }
    const github_id = (userRows[0] as any).github_id;

    // 生成 token (github_id:randomHex)
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const randomHex = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const token = `${github_id}:${randomHex}`;

    // 7 天过期
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    this.db.exec('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, user_id, expiresAt);

    // 清理该用户的过期 session
    this.db.exec("DELETE FROM sessions WHERE user_id = ? AND expires_at < datetime('now')", user_id);

    return Response.json({ token, expires_at: expiresAt });
  }

  private async handleSessionVerify(request: Request): Promise<Response> {
    const { token } = await request.json<{ token: string }>();

    const rows = this.db
      .exec(
        `SELECT u.id, u.github_id, u.username, u.avatar_url
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.token = ? AND s.expires_at > datetime('now')`,
        token
      )
      .toArray();

    if (rows.length === 0) {
      return Response.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    return Response.json(rows[0] as unknown as UserInfo);
  }

  private async handleSessionDelete(request: Request): Promise<Response> {
    const { token } = await request.json<{ token: string }>();
    this.db.exec('DELETE FROM sessions WHERE token = ?', token);
    return Response.json({ success: true });
  }

  // ==================== 服务器 CRUD ====================

  private handleGetServers(userId: number): Response {
    const rows = this.db
      .exec(
        `SELECT id, user_id, name, host, port, username, auth_method, region, inferred_hint, tags, os, jump_server_id, created_at, updated_at
         FROM servers WHERE user_id = ? ORDER BY updated_at DESC`,
        userId
      )
      .toArray();

    return Response.json(rows.map((row: Record<string, unknown>) => deserializeServerRow(row)) as unknown as ServerConfig[]);
  }

  private validateJumpChain(userId: number, targetServerId: number | null, jumpServerId: number | null): string | null {
    if (jumpServerId === null) return null;
    if (!Number.isInteger(jumpServerId) || jumpServerId <= 0) return '无效的跳板服务器';

    const seen = new Set<number>();
    if (targetServerId !== null) seen.add(targetServerId);
    let currentId: number | null = jumpServerId;
    let depth = 0;

    while (currentId !== null) {
      if (seen.has(currentId)) return '跳板服务器关系不能形成循环';
      seen.add(currentId);
      depth++;
      if (depth > MAX_JUMP_HOSTS) return `最多允许 ${MAX_JUMP_HOSTS} 级 SSH 跳转`;

      const rows = this.db.exec(
        'SELECT user_id, jump_server_id FROM servers WHERE id = ?',
        currentId,
      ).toArray();
      if (rows.length === 0) return '所选跳板服务器不存在';
      const row = rows[0] as unknown as { user_id: number; jump_server_id: number | null };
      if (row.user_id !== userId) return '不能使用其他用户的服务器作为跳板';
      currentId = row.jump_server_id ?? null;
    }
    return null;
  }

  private async handleAddServer(request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      name: string;
      host: string;
      port: number;
      username: string;
      credential: string;
      auth_method: string;
      region?: string;
      tags?: unknown;
      jump_server_id?: number | null;
    }>();

    const port = body.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Response.json({ error: '端口必须是 1-65535 之间的整数' }, { status: 400 });
    }
    if (!AUTH_METHODS.has(body.auth_method)) {
      return Response.json({ error: '不支持的认证方式' }, { status: 400 });
    }
    if (typeof body.credential !== 'string' || body.credential.length === 0) {
      return Response.json({ error: '认证凭据不能为空' }, { status: 400 });
    }
    const jumpServerId = body.jump_server_id ?? null;
    const jumpError = this.validateJumpChain(body.user_id, null, jumpServerId);
    if (jumpError) return Response.json({ error: jumpError }, { status: 400 });

    const region = (ALLOWED_LOCATION_HINTS as readonly string[]).includes(body.region || '')
      ? body.region || null
      : null;

    // 加密凭据
    const encrypted = await this.encryptCredential(body.credential, body.user_id);

    // Auto 模式保存时一次性推断 locationHint，结果持久化入 inferred_hint 列
    // 手动区域已经能够直接决定调度，无需向 IPinfo 发送主机信息
    // 失败时返回 null，连接时退化为 Auto
    let inferredHint: string | null = null;
    let inferDebug: string[] = [];
    if (region === null) {
      try {
        const result = await inferLocationHint(body.host);
        inferredHint = result.hint ?? null;
        inferDebug = result.debug;
      } catch (e) {
        inferDebug.push(`[IP-GEO] 异常: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      inferDebug.push('[IP-GEO] 已手动指定区域，跳过推断');
    }

    // Encryption and IP inference may yield; re-check the saved relation at
    // the write boundary to keep the maximum depth invariant.
    const currentJumpError = this.validateJumpChain(body.user_id, null, jumpServerId);
    if (currentJumpError) return Response.json({ error: currentJumpError }, { status: 400 });

    this.db.exec(
      'INSERT INTO servers (user_id, name, host, port, username, credential, auth_method, region, inferred_hint, tags, jump_server_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      body.user_id,
      body.name,
      body.host,
      port,
      body.username,
      encrypted,
      body.auth_method,
      region,
      inferredHint,           // 系统推断值（可 NULL）
      serializeServerTags(body.tags),
      jumpServerId,
    );

    // 获取新创建的记录
    const rows = this.db
      .exec(
        `SELECT id, user_id, name, host, port, username, auth_method, region, inferred_hint, tags, os, jump_server_id, created_at, updated_at
         FROM servers WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
        body.user_id
      )
      .toArray();

    // DEBUG_MODE 开启时，在响应中附带调试信息
    const server = deserializeServerRow(rows[0] as Record<string, unknown>) as unknown as ServerConfig;
    if (this.env.DEBUG_MODE === 'true') {
      return Response.json({ ...server, _debug: inferDebug }, { status: 201 });
    }
    return Response.json(server, { status: 201 });
  }

  private async handleUpdateServer(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      name?: string;
      host?: string;
      port?: number;
      username?: string;
      credential?: string;
      auth_method?: string;
      region?: string;
      tags?: unknown;
      jump_server_id?: number | null;
    }>();

    // 验证服务器属于该用户
    const existing = this.db.exec(
      'SELECT user_id, host, port, auth_method, region, inferred_hint, jump_server_id FROM servers WHERE id = ?',
      serverId,
    ).toArray();
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    const current = existing[0] as unknown as {
      user_id: number;
      host: string;
      port: number;
      auth_method: string;
      region: string | null;
      inferred_hint: string | null;
      jump_server_id: number | null;
    };
    if (current.user_id !== body.user_id)
      return Response.json({ error: 'Forbidden' }, { status: 403 });

    if (body.auth_method !== undefined && !AUTH_METHODS.has(body.auth_method)) {
      return Response.json({ error: '不支持的认证方式' }, { status: 400 });
    }
    const hasNewCredential = typeof body.credential === 'string' && body.credential.length > 0;
    if (body.credential !== undefined && !hasNewCredential) {
      return Response.json({ error: '认证凭据不能为空' }, { status: 400 });
    }
    if (body.auth_method !== undefined
      && body.auth_method !== current.auth_method
      && !hasNewCredential) {
      return Response.json({ error: '切换认证方式时必须同时提供对应凭据' }, { status: 400 });
    }
    if (body.jump_server_id !== undefined) {
      const jumpError = this.validateJumpChain(body.user_id, serverId, body.jump_server_id);
      if (jumpError) return Response.json({ error: jumpError }, { status: 400 });
    }

    const normalizedRegion = body.region !== undefined
      ? ((ALLOWED_LOCATION_HINTS as readonly string[]).includes(body.region) ? body.region : null)
      : current.region;
    const hostChanged = body.host !== undefined && body.host !== current.host;
    const portChanged = body.port !== undefined && body.port !== current.port;
    const switchedToAuto = body.region !== undefined
      && normalizedRegion === null
      && current.region !== null;

    // 构建更新语句
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.host !== undefined) {
      updates.push('host = ?');
      values.push(body.host);
    }
    if (hostChanged) {
      // 手动区域无需推断；Auto 模式仅在主机实际变化时重新查询
      let newInferred: string | null = null;
      if (normalizedRegion === null) {
        try {
          const result = await inferLocationHint(body.host!);
          newInferred = result.hint ?? null;
        } catch {
          newInferred = null;
        }
      }
      updates.push('inferred_hint = ?');
      values.push(newInferred);
    } else if (switchedToAuto && current.inferred_hint === null) {
      // 手动模式新增的记录没有推断值，首次切回 Auto 时补做一次查询
      let newInferred: string | null = null;
      try {
        const result = await inferLocationHint(current.host);
        newInferred = result.hint ?? null;
      } catch {
        newInferred = null;
      }
      updates.push('inferred_hint = ?');
      values.push(newInferred);
    }
    if (body.port !== undefined) {
      if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
        return Response.json({ error: '端口必须是 1-65535 之间的整数' }, { status: 400 });
      }
      updates.push('port = ?');
      values.push(body.port);
    }
    if (hostChanged || portChanged) {
      // 主机地址或端口可能指向另一台 SSH 服务，旧 OS 结果不可继续复用。
      updates.push('os = NULL');
    }
    if (body.username !== undefined) {
      updates.push('username = ?');
      values.push(body.username);
    }
    if (hasNewCredential) {
      const encrypted = await this.encryptCredential(body.credential!, body.user_id);
      updates.push('credential = ?');
      values.push(encrypted);
    }
    if (body.auth_method !== undefined) {
      updates.push('auth_method = ?');
      values.push(body.auth_method);
    }
    if (body.region !== undefined) {
      // 空字符串视为 Auto（清空手动覆盖）；白名单校验非法值
      updates.push('region = ?');
      values.push(normalizedRegion);
    }
    if (body.tags !== undefined) {
      updates.push('tags = ?');
      values.push(serializeServerTags(body.tags));
    }
    if (body.jump_server_id !== undefined) {
      updates.push('jump_server_id = ?');
      values.push(body.jump_server_id);
    }

    if (updates.length > 0) {
      // Credential encryption and region inference may yield; validate again
      // immediately before the write so concurrent updates cannot create a cycle.
      if (body.jump_server_id !== undefined) {
        const jumpError = this.validateJumpChain(body.user_id, serverId, body.jump_server_id);
        if (jumpError) return Response.json({ error: jumpError }, { status: 400 });
      }
      updates.push("updated_at = datetime('now')");
      values.push(serverId);
      this.db.exec(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`, ...values);
    }

    const row = this.db
      .exec(
        `SELECT id, user_id, name, host, port, username, auth_method, region, inferred_hint, tags, os, jump_server_id, created_at, updated_at
         FROM servers WHERE id = ?`,
        serverId
      )
      .toArray();

    return Response.json(deserializeServerRow(row[0] as Record<string, unknown>) as unknown as ServerConfig);
  }

  private async handleDeleteServer(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{ user_id: number }>();

    // 验证服务器属于该用户
    const existing = this.db.exec('SELECT user_id FROM servers WHERE id = ?', serverId).toArray();
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    if ((existing[0] as unknown as { user_id: number }).user_id !== body.user_id)
      return Response.json({ error: 'Forbidden' }, { status: 403 });

    const references = this.db.exec(
      'SELECT name FROM servers WHERE user_id = ? AND jump_server_id = ? ORDER BY name LIMIT 5',
      body.user_id,
      serverId,
    ).toArray() as unknown as Array<{ name: string }>;
    if (references.length > 0) {
      return Response.json({
        error: `该服务器正被 ${references.map((row) => row.name).join('、')} 用作跳板，请先解除引用`,
      }, { status: 409 });
    }

    this.db.exec('DELETE FROM servers WHERE id = ?', serverId);
    return Response.json({ success: true });
  }

  /**
   * 更新服务器检测到的操作系统标识。
   * 仅由 SSHSession（已认证会话）通过 DO stub 调用，不对外暴露公开路由。
   */
  private async handleUpdateServerOS(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{ user_id: number; os: string }>();

    // 验证服务器属于该用户
    const existing = this.db.exec('SELECT user_id FROM servers WHERE id = ?', serverId).toArray();
    if (existing.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
    if ((existing[0] as unknown as { user_id: number }).user_id !== body.user_id) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!isDetectedOS(body.os)) {
      return Response.json({ error: 'Invalid os' }, { status: 400 });
    }

    this.db.exec(
      'UPDATE servers SET os = ? WHERE id = ?',
      body.os,
      serverId
    );
    return Response.json({ success: true });
  }

  // ==================== 用户自定义主题 ====================

  private handleGetTheme(userId: number): Response {
    const rows = this.db
      .exec('SELECT theme_data FROM user_themes WHERE user_id = ?', userId)
      .toArray();

    if (rows.length === 0) {
      return Response.json({ theme: null });
    }

    try {
      return Response.json({ theme: JSON.parse((rows[0] as unknown as { theme_data: string }).theme_data) });
    } catch {
      return Response.json({ theme: null });
    }
  }

  private async handlePutTheme(request: Request): Promise<Response> {
    const { user_id, theme_data } = await request.json<{ user_id: number; theme_data: string }>();

    this.db.exec(
      `INSERT INTO user_themes (user_id, theme_data, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET theme_data = excluded.theme_data, updated_at = excluded.updated_at`,
      user_id,
      theme_data
    );

    return Response.json({ success: true });
  }

  // ==================== One-time-token 连接 ====================

  private async handleConnectServer(serverId: number, request: Request): Promise<Response> {
    const body = await request.json<{ user_id: number }>();

    // Resolve the saved relation into one bounded, immutable outer-to-target chain.
    const reversed: StoredServerRow[] = [];
    const seen = new Set<number>();
    let currentId: number | null = serverId;
    while (currentId !== null) {
      if (seen.has(currentId)) {
        return Response.json({ error: '跳板服务器关系存在循环' }, { status: 400 });
      }
      seen.add(currentId);
      const rows = this.db.exec('SELECT * FROM servers WHERE id = ?', currentId).toArray();
      if (rows.length === 0) return Response.json({ error: 'Server not found' }, { status: 404 });
      const row = rows[0] as unknown as StoredServerRow;
      if (row.user_id !== body.user_id) return Response.json({ error: 'Forbidden' }, { status: 403 });
      reversed.push(row);
      if (reversed.length > MAX_JUMP_HOSTS + 1) {
        return Response.json({ error: `最多允许 ${MAX_JUMP_HOSTS} 级 SSH 跳转` }, { status: 400 });
      }
      currentId = row.jump_server_id ?? null;
    }

    const chain = reversed.reverse();
    const target = chain[chain.length - 1];
    const pathSegments: string[] = [];
    const resolved = await Promise.all(chain.map(async (server, index) => {
      const identity = index === 0
        ? server.host
        : `jump:${pathSegments.join('>')}|${server.host}`;
      pathSegments.push(`${server.id}@${server.host}:${server.port}`);
      const credential = await this.decryptCredential(server.credential, body.user_id);
      const khRows = this.db.exec(
        'SELECT fingerprint FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?',
        body.user_id,
        identity,
        server.port,
      ).toArray();
      return {
        server,
        identity,
        credential,
        expectedFingerprint: khRows.length > 0
          ? (khRows[0] as unknown as { fingerprint: string }).fingerprint
          : undefined,
      };
    }));

    const outermost = chain[0];
    const locationHint = outermost.region || outermost.inferred_hint || undefined;

    const userRows = this.db.exec('SELECT github_id FROM users WHERE id = ?', body.user_id).toArray();
    if (userRows.length === 0) return Response.json({ error: 'User not found' }, { status: 404 });
    const github_id = (userRows[0] as any).github_id;

    // 生成 one-time-token
    const token = `${github_id}:${crypto.randomUUID()}`;
    const jumpHosts: SSHJumpHostConfig[] = resolved.slice(0, -1).map((node) => ({
      serverId: node.server.id,
      name: node.server.name,
      host: node.server.host,
      port: node.server.port,
      username: node.server.username,
      password: node.server.auth_method === 'password' ? node.credential : '',
      authMethod: node.server.auth_method === 'publickey' ? 'publickey' : 'password',
      privateKey: node.server.auth_method === 'publickey' ? node.credential : '',
      expectedFingerprint: node.expectedFingerprint,
      knownHostIdentity: node.identity,
    }));
    const targetNode = resolved[resolved.length - 1];
    const config: SSHConnectionConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.auth_method === 'password' ? targetNode.credential : '',
      authMethod: target.auth_method === 'publickey' ? 'publickey' : 'password',
      privateKey: target.auth_method === 'publickey' ? targetNode.credential : '',
      expectedFingerprint: targetNode.expectedFingerprint,
      knownHostIdentity: targetNode.identity,
      userId: String(body.user_id),
      githubId: String(github_id),
      serverId: target.id,
      os: target.os,
      locationHint,
      jumpHosts,
    };

    // 防止 token 数量无限增长
    if (this.connectTokens.size >= UserDBDO.MAX_CONNECT_TOKENS) {
      this.cleanExpiredTokens();
      if (this.connectTokens.size >= UserDBDO.MAX_CONNECT_TOKENS) {
        return Response.json({ error: 'Too many pending connections' }, { status: 429 });
      }
    }

    // 存入内存，60 秒过期
    this.connectTokens.set(token, {
      config,
      expiresAt: Date.now() + 60_000,
    });

    return Response.json({ token });
  }

  private async handleConsumeToken(request: Request): Promise<Response> {
    const { token } = await request.json<{ token: string }>();

    const entry = this.connectTokens.get(token);
    if (!entry) return Response.json({ error: 'Invalid or expired token' }, { status: 404 });

    // 立即删除（一次性）
    this.connectTokens.delete(token);

    if (Date.now() > entry.expiresAt) {
      return Response.json({ error: 'Token expired' }, { status: 410 });
    }

    return Response.json(entry.config);
  }

  private cleanExpiredTokens(): void {
    const now = Date.now();
    for (const [key, value] of this.connectTokens) {
      if (now > value.expiresAt) {
        this.connectTokens.delete(key);
      }
    }
  }

  // ==================== 凭据加密 ====================

  /**
   * AES-256-GCM 加密凭据
   * 密钥派生：PBKDF2(自动密钥, salt="cloudssh:userdb:" + user_id)
   * 存储格式：base64(iv + ciphertext + tag)
   */
  private async encryptCredential(plaintext: string, userId: number): Promise<string> {
    const key = await this.deriveEncryptionKey(userId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
    );

    // iv (12) + ciphertext+tag
    const combined = new Uint8Array(iv.length + ciphertext.length);
    combined.set(iv, 0);
    combined.set(ciphertext, iv.length);

    return btoa(String.fromCharCode(...combined));
  }

  private async decryptCredential(stored: string, userId: number): Promise<string> {
    const key = await this.deriveEncryptionKey(userId);
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const iv = raw.slice(0, 12);
    const ciphertext = raw.slice(12);

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  }

  private encryptionSecret: string | null = null;

  private async deriveEncryptionKey(userId: number): Promise<CryptoKey> {
    const cached = this.derivedKeyCache.get(userId);
    if (cached) return cached;

    if (!this.encryptionSecret) {
      const rows = this.db.exec("SELECT value FROM system_config WHERE key = 'encryption_secret'").toArray();
      if (rows.length > 0) {
        this.encryptionSecret = rows[0].value as string;
      } else {
        // 兼容旧版：检查 session_secret 并迁移到 encryption_secret
        const oldRows = this.db.exec("SELECT value FROM system_config WHERE key = 'session_secret'").toArray();
        if (oldRows.length > 0) {
          this.encryptionSecret = oldRows[0].value as string;
          this.db.exec("INSERT INTO system_config (key, value) VALUES ('encryption_secret', ?)", this.encryptionSecret);
        } else {
          const bytes = new Uint8Array(32);
          crypto.getRandomValues(bytes);
          this.encryptionSecret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
          this.db.exec("INSERT INTO system_config (key, value) VALUES ('encryption_secret', ?)", this.encryptionSecret);
        }
      }
    }

    const salt = new TextEncoder().encode(`cloudssh:userdb:${userId}`);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.encryptionSecret),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    const derived = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    this.derivedKeyCache.set(userId, derived);
    return derived;
  }

  // ==================== known_hosts 管理 ====================

  private handleGetKnownHosts(userId: number, host: string | null, port: string | null): Response {
    if (host && port) {
      // 查询特定 host:port 的指纹
      const rows = this.db.exec(
        'SELECT fingerprint FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?',
        userId, host, parseInt(port)
      ).toArray();
      if (rows.length === 0) {
        return Response.json({ fingerprint: null });
      }
      return Response.json({ fingerprint: (rows[0] as unknown as { fingerprint: string }).fingerprint });
    }

    // 列出所有已知主机
    const rows = this.db.exec(
      'SELECT id, host, port, fingerprint, created_at, updated_at FROM known_hosts WHERE user_id = ? ORDER BY updated_at DESC',
      userId
    ).toArray();
    return Response.json(rows);
  }

  private async handleUpsertKnownHost(request: Request): Promise<Response> {
    const { user_id, host, port, fingerprint } = await request.json<{
      user_id: number;
      host: string;
      port: number;
      fingerprint: string;
    }>();

    if (!host || !port || !fingerprint) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    this.db.exec(
      `INSERT INTO known_hosts (user_id, host, port, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id, host, port) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = datetime('now')`,
      user_id, host, port, fingerprint
    );

    return Response.json({ success: true });
  }

  private async handleDeleteKnownHost(request: Request): Promise<Response> {
    const { user_id, host, port } = await request.json<{
      user_id: number;
      host: string;
      port: number;
    }>();

    this.db.exec(
      'DELETE FROM known_hosts WHERE user_id = ? AND host = ? AND port = ?',
      user_id, host, port
    );

    return Response.json({ success: true });
  }

  // ==================== AI 配置管理 ====================

  private handleGetAIConfig(userId: number): Response {
    const rows = this.db.exec(
      'SELECT base_url, model, api_key_last4, updated_at FROM ai_configs WHERE user_id = ?',
      userId
    ).toArray();

    if (rows.length === 0) {
      return Response.json({ configured: false });
    }

    const row = rows[0] as unknown as {
      base_url: string; model: string; api_key_last4: string; updated_at: string;
    };
    return Response.json({
      configured: true,
      base_url: row.base_url,
      model: row.model,
      api_key_last4: row.api_key_last4,
      updated_at: row.updated_at,
    });
  }

  private async handlePutAIConfig(request: Request): Promise<Response> {
    const body = await request.json<{
      user_id: number;
      base_url: string;
      model: string;
      api_key?: string;
    }>();

    if (!body.user_id || !body.base_url || !body.model) {
      return Response.json({ error: 'Missing user_id, base_url or model' }, { status: 400 });
    }

    // Check if an existing configuration exists with a valid API key
    const existing = this.db.exec(
      'SELECT api_key_enc FROM ai_configs WHERE user_id = ?',
      body.user_id
    ).toArray();
    const hasExistingKey = existing.length > 0 && !!(existing[0] as any).api_key_enc;

    if (!body.api_key && !hasExistingKey) {
      return Response.json({ error: '首次配置必须填写 API Key' }, { status: 400 });
    }

    let encrypted: string | null = null;
    let last4: string | null = null;

    if (body.api_key) {
      encrypted = await this.encryptCredential(body.api_key, body.user_id);
      last4 = body.api_key.slice(-4);
    }

    if (encrypted !== null) {
      this.db.exec(
        `INSERT INTO ai_configs (user_id, base_url, model, api_key_enc, api_key_last4, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           base_url = excluded.base_url,
           model = excluded.model,
           api_key_enc = excluded.api_key_enc,
           api_key_last4 = excluded.api_key_last4,
           updated_at = excluded.updated_at`,
        body.user_id, body.base_url, body.model, encrypted, last4
      );
    } else {
      this.db.exec(
        `INSERT INTO ai_configs (user_id, base_url, model, api_key_enc, api_key_last4, updated_at)
         VALUES (?, ?, ?, '', '', datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           base_url = excluded.base_url,
           model = excluded.model,
           updated_at = excluded.updated_at`,
        body.user_id, body.base_url, body.model
      );
    }

    return Response.json({ success: true });
  }

  private async handleGetAIConfigDecrypted(userId: number): Promise<Response> {
    const rows = this.db.exec(
      'SELECT base_url, model, api_key_enc FROM ai_configs WHERE user_id = ?',
      userId
    ).toArray();

    if (rows.length === 0) {
      return Response.json({ error: 'No AI config found' }, { status: 404 });
    }

    const row = rows[0] as unknown as {
      base_url: string; model: string; api_key_enc: string;
    };

    if (!row.api_key_enc) {
      return Response.json({ error: 'No API key configured' }, { status: 404 });
    }

    const decrypted = await this.decryptCredential(row.api_key_enc, userId);

    return Response.json({
      base_url: row.base_url,
      model: row.model,
      api_key: decrypted,
    });
  }
}
