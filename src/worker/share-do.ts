import type { Env, SSHConnectionConfig } from '../types';

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const MAX_AUDIT_EVENTS = 5000;

/** 审计保留期默认值（天）：创建分享时可按链接自定义（7–365）。 */
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

const TERMINAL_SHARE_STATUSES: ReadonlySet<ShareStatus> = new Set(['closed', 'revoked', 'expired']);
const CONNECT_TICKET_TTL_MS = 60_000;

type ShareStatus = 'unused' | 'claimed' | 'active' | 'closed' | 'revoked' | 'expired';

interface ShareStateRow {
  share_id: string;
  token_hash: string;
  owner_user_id: number;
  owner_github_id: string;
  server_id: number;
  server_name: string;
  expires_at: number;
  max_session_seconds: number;
  status: ShareStatus;
  claimed_at: number | null;
  active_at: number | null;
  closed_at: number | null;
  session_expires_at: number | null;
  session_name: string | null;
  ticket_hash: string | null;
  ticket_expires_at: number | null;
  audit_bytes: number;
  device_pub_key: string | null;
  audit_purge_due: number | null;
  audit_retention_days: number | null;
}

interface ShareInitBody {
  shareId: string;
  tokenHash: string;
  ownerUserId: number;
  ownerGithubId: string;
  serverId: number;
  serverName: string;
  expiresAt: number;
  maxSessionSeconds: number;
  /** 审计明细保留天数（7–365）；缺省时服务端取默认 90 天。 */
  auditRetentionDays?: number;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** 审计详情始终由 appendAudit 以 JSON.stringify 写入；防御性解析避免脏数据抛错。 */
function safeParseDetails(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * 每个分享凭证对应一个独立 Durable Object。
 * 链接中的随机 token 经哈希后只用于定位该对象，持久层也仅保存 token 哈希。
 */
export class SSHShareDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly db: any;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.db = (state.storage as any).sql;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS share_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        share_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        owner_user_id INTEGER NOT NULL,
        owner_github_id TEXT NOT NULL,
        server_id INTEGER NOT NULL,
        server_name TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        max_session_seconds INTEGER NOT NULL,
        status TEXT NOT NULL,
        claimed_at INTEGER,
        active_at INTEGER,
        closed_at INTEGER,
        session_expires_at INTEGER,
        session_name TEXT,
        ticket_hash TEXT,
        ticket_expires_at INTEGER,
        audit_bytes INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        byte_size INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_share_audit_time ON audit_events(occurred_at, id);
    `);
    // 迁移：认领设备公钥（SPKI base64url，用于断线重连的设备绑定验签）。
    // 已有环境的表结构通过 ALTER TABLE 补列，列已存在时忽略。
    try {
      this.db.exec('ALTER TABLE share_state ADD COLUMN device_pub_key TEXT');
    } catch {
      /* column already exists */
    }
    // 迁移：审计保留期到期时间（终态后自动清理调度用）。
    try {
      this.db.exec('ALTER TABLE share_state ADD COLUMN audit_purge_due INTEGER');
    } catch {
      /* column already exists */
    }
    // 迁移：审计保留天数（创建时可自定义；NULL 表示使用默认 90 天）。
    try {
      this.db.exec('ALTER TABLE share_state ADD COLUMN audit_retention_days INTEGER');
    } catch {
      /* column already exists */
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/internal/init' && request.method === 'POST') {
        return this.initialize(await request.json<ShareInitBody>());
      }
      if (url.pathname === '/internal/claim' && request.method === 'POST') {
        return this.claim(await request.json<{ token?: string; devicePubKey?: string }>());
      }
      if (url.pathname === '/internal/connect/consume' && request.method === 'POST') {
        return this.consumeConnection(
          await request.json<{ ticket?: string; sessionName?: string }>()
        );
      }
      if (url.pathname === '/internal/audit/event' && request.method === 'POST') {
        return this.appendAuditEvent(await request.json<Record<string, unknown>>());
      }
      if (url.pathname === '/internal/revoke' && request.method === 'POST') {
        return this.revoke('revoked');
      }
      if (url.pathname === '/internal/session/closed' && request.method === 'POST') {
        return this.closeSession(await request.json<{ normal?: boolean }>());
      }
      if (url.pathname === '/internal/owner-view' && request.method === 'GET') {
        const ownerUserId = Number(url.searchParams.get('owner_user_id'));
        const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
        return this.ownerView(ownerUserId, after, limit);
      }
      if (url.pathname === '/internal/audit/purge' && request.method === 'POST') {
        return this.purgeAudit(await request.json<{ ownerUserId?: number }>());
      }
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('SSHShareDO error:', error instanceof Error ? error.message : String(error));
      return jsonError('Share service unavailable', 500);
    }
  }

  async alarm(): Promise<void> {
    const share = this.getShare();
    if (!share) return;
    const now = Date.now();
    // 审计保留期：终态满 90 天自动清除明细并写入自动清理墓碑
    if (
      TERMINAL_SHARE_STATUSES.has(share.status) &&
      share.audit_purge_due !== null &&
      now >= share.audit_purge_due
    ) {
      await this.purgeAuditContent(share, 'share.audit_auto_purged');
      this.db.exec('UPDATE share_state SET audit_purge_due = NULL');
      return;
    }
    if (share.status === 'unused' && now >= share.expires_at) {
      await this.updateStatus(share, 'expired', now);
      await this.syncOwnerMetadata(share, 'expired', { closedAt: now });
      return;
    }
    if (
      (share.status === 'claimed' || share.status === 'active') &&
      share.session_expires_at &&
      now >= share.session_expires_at
    ) {
      await this.revoke('closed');
      return;
    }
    await this.scheduleNextAlarm(share);
  }

  private async initialize(body: ShareInitBody): Promise<Response> {
    if (this.getShare()) return jsonError('Share already initialized', 409);
    if (!body.shareId || !body.tokenHash || !body.ownerGithubId || !body.serverName) {
      return jsonError('Invalid share metadata', 400);
    }
    if (!Number.isInteger(body.ownerUserId) || !Number.isInteger(body.serverId)) {
      return jsonError('Invalid share owner or server', 400);
    }
    if (!Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
      return jsonError('Invalid share expiry', 400);
    }
    if (
      !Number.isInteger(body.maxSessionSeconds) ||
      body.maxSessionSeconds < 300 ||
      body.maxSessionSeconds > 7200
    ) {
      return jsonError('Invalid maximum session duration', 400);
    }
    // 审计保留天数：可选；未提供时存 NULL（运行时取默认 90 天）。
    let auditRetentionDays: number | null = null;
    if (body.auditRetentionDays !== undefined) {
      if (
        !Number.isInteger(body.auditRetentionDays) ||
        body.auditRetentionDays < 7 ||
        body.auditRetentionDays > 365
      ) {
        return jsonError('Invalid audit retention', 400);
      }
      auditRetentionDays = body.auditRetentionDays;
    }
    this.db.exec(
      `INSERT INTO share_state (
        singleton, share_id, token_hash, owner_user_id, owner_github_id,
        server_id, server_name, expires_at, max_session_seconds,
        audit_retention_days, status
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unused')`,
      body.shareId,
      body.tokenHash,
      body.ownerUserId,
      body.ownerGithubId,
      body.serverId,
      body.serverName,
      body.expiresAt,
      body.maxSessionSeconds,
      auditRetentionDays
    );
    await this.state.storage.setAlarm(body.expiresAt);
    return Response.json({ success: true });
  }

  private async claim(body: { token?: string; devicePubKey?: string }): Promise<Response> {
    const share = this.getShare();
    if (!share || typeof body.token !== 'string') return jsonError('Invalid share link', 404);
    if ((await sha256Base64Url(body.token)) !== share.token_hash)
      return jsonError('Invalid share link', 404);
    // 设备绑定公钥（可选）：格式为 SPKI DER 的 base64url 编码，仅接受合理的长度范围。
    const devicePubKey =
      typeof body.devicePubKey === 'string' && /^[A-Za-z0-9_-]{80,600}$/.test(body.devicePubKey)
        ? body.devicePubKey
        : null;
    const now = Date.now();
    if (share.status !== 'unused')
      return jsonError('This share link has already been used or revoked', 409);
    if (now >= share.expires_at) {
      await this.updateStatus(share, 'expired', now);
      await this.syncOwnerMetadata(share, 'expired', { closedAt: now });
      return jsonError('This share link has expired', 410);
    }

    const ticket = randomToken();
    const ticketHash = await sha256Base64Url(ticket);
    const sessionExpiresAt = now + share.max_session_seconds * 1000;
    this.db.exec(
      `UPDATE share_state SET status = 'claimed', claimed_at = ?, session_expires_at = ?,
       ticket_hash = ?, ticket_expires_at = ?, device_pub_key = ? WHERE singleton = 1 AND status = 'unused'`,
      now,
      sessionExpiresAt,
      ticketHash,
      now + CONNECT_TICKET_TTL_MS,
      devicePubKey
    );
    const updated = this.getShare();
    if (!updated || updated.status !== 'claimed' || updated.ticket_hash !== ticketHash) {
      return jsonError('This share link has already been used', 409);
    }
    await this.appendAudit('share.claimed', { serverName: share.server_name }, now);
    await this.syncOwnerMetadata(updated, 'claimed', { claimedAt: now });
    await this.scheduleNextAlarm(updated);
    return Response.json({
      ticket,
      serverName: share.server_name,
      sessionExpiresAt,
    });
  }

  private async consumeConnection(body: {
    ticket?: string;
    sessionName?: string;
  }): Promise<Response> {
    const share = this.getShare();
    if (!share || typeof body.ticket !== 'string' || typeof body.sessionName !== 'string') {
      return jsonError('Invalid connection ticket', 400);
    }
    const now = Date.now();
    if (share.status !== 'claimed' || !share.ticket_hash || !share.ticket_expires_at) {
      return jsonError('Connection ticket has already been used', 409);
    }
    if (now >= share.ticket_expires_at || now >= (share.session_expires_at ?? 0)) {
      await this.revoke('expired');
      return jsonError('Connection ticket expired', 410);
    }
    if ((await sha256Base64Url(body.ticket)) !== share.ticket_hash) {
      return jsonError('Invalid connection ticket', 403);
    }

    this.db.exec(
      `UPDATE share_state SET status = 'active', active_at = ?, session_name = ?,
       ticket_hash = NULL, ticket_expires_at = NULL WHERE singleton = 1 AND status = 'claimed'`,
      now,
      body.sessionName
    );
    const active = this.getShare();
    if (!active || active.status !== 'active' || active.session_name !== body.sessionName) {
      return jsonError('Connection ticket has already been used', 409);
    }

    const ownerStub = this.env.USER_DB.get(this.env.USER_DB.idFromName(active.owner_github_id));
    const configResponse = await ownerStub.fetch(
      new Request(`http://internal/internal/servers/${active.server_id}/share-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: active.owner_user_id,
          share_id: active.share_id,
          share_ref: active.token_hash,
          session_expires_at: active.session_expires_at,
        }),
      })
    );
    if (!configResponse.ok) {
      const error = await configResponse.text();
      await this.appendAudit('session.connection_failed', { status: configResponse.status }, now);
      await this.updateStatus(active, 'closed', now);
      await this.syncOwnerMetadata(active, 'closed', { closedAt: now });
      return new Response(error, {
        status: configResponse.status,
        headers: {
          'Content-Type': configResponse.headers.get('Content-Type') || 'application/json',
        },
      });
    }

    const config = await configResponse.json<SSHConnectionConfig>();
    await this.appendAudit('session.connecting', {}, now);
    await this.syncOwnerMetadata(active, 'active', { activeAt: now });
    await this.scheduleNextAlarm(active);
    return Response.json({
      config,
      serverName: active.server_name,
      devicePubKey: active.device_pub_key ?? null,
    });
  }

  private async appendAuditEvent(body: Record<string, unknown>): Promise<Response> {
    const share = this.getShare();
    if (!share) return jsonError('Share not found', 404);
    if (share.status !== 'active' && share.status !== 'claimed') {
      return jsonError('Share session is not active', 409);
    }
    const eventType = typeof body.eventType === 'string' ? body.eventType.slice(0, 64) : '';
    const occurredAt =
      typeof body.occurredAt === 'number' && Number.isFinite(body.occurredAt)
        ? Math.floor(body.occurredAt)
        : Date.now();
    if (!eventType) return jsonError('Invalid audit event', 400);
    const details = body.details && typeof body.details === 'object' ? body.details : {};
    const serialized = JSON.stringify(details);
    const byteSize = new TextEncoder().encode(serialized).length;
    if (byteSize > 64 * 1024) return jsonError('Audit event too large', 413);
    const count = Number(this.db.exec('SELECT COUNT(*) AS count FROM audit_events').one().count);
    if (count >= MAX_AUDIT_EVENTS || share.audit_bytes + byteSize > MAX_AUDIT_BYTES) {
      await this.revoke('closed');
      return jsonError('Audit storage limit reached; the shared session was closed', 507);
    }
    await this.appendAudit(eventType, details, occurredAt, byteSize);
    return Response.json({ success: true });
  }

  private async closeSession(body: { normal?: boolean }): Promise<Response> {
    const share = this.getShare();
    if (!share) return jsonError('Share not found', 404);
    if (share.status === 'closed' || share.status === 'revoked' || share.status === 'expired') {
      return Response.json({ success: true });
    }
    const now = Date.now();
    await this.appendAudit('session.closed', { normal: body.normal === true }, now);
    await this.updateStatus(share, 'closed', now);
    await this.syncOwnerMetadata(share, 'closed', { closedAt: now });
    return Response.json({ success: true });
  }

  private async revoke(status: 'revoked' | 'expired' | 'closed'): Promise<Response> {
    const share = this.getShare();
    if (!share) return jsonError('Share not found', 404);
    if (share.status === 'closed' || share.status === 'revoked' || share.status === 'expired') {
      return Response.json({ success: true });
    }
    const now = Date.now();
    await this.appendAudit(`share.${status}`, {}, now);
    await this.updateStatus(share, status, now);
    if (share.session_name) {
      const sessionStub = this.env.SSH_SESSION.get(
        this.env.SSH_SESSION.idFromName(share.session_name)
      );
      await sessionStub
        .fetch(
          new Request('http://internal/internal/revoke-share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shareId: share.share_id }),
          })
        )
        .catch(() => null);
    }
    await this.syncOwnerMetadata(share, status, { closedAt: now });
    return Response.json({ success: true });
  }

  /** 分享者清空终态会话的全部审计明细，写入墓碑事件保留追责线索。 */
  private async purgeAudit(body: { ownerUserId?: number }): Promise<Response> {
    const share = this.getShare();
    if (!share) return jsonError('Share not found', 404);
    if (!Number.isInteger(body.ownerUserId) || body.ownerUserId !== share.owner_user_id) {
      return jsonError('Forbidden', 403);
    }
    if (!TERMINAL_SHARE_STATUSES.has(share.status)) {
      return jsonError('Share session is not finished', 409);
    }
    await this.purgeAuditContent(share, 'share.audit_purged');
    this.db.exec('UPDATE share_state SET audit_purge_due = NULL');
    // 手动清空即代表不再需要自动清理：取消已排期的唤醒，避免 90 天后一次无效唤起
    try {
      await this.state.storage.deleteAlarm();
    } catch {
      /* 当前无闹钟时忽略 */
    }
    return Response.json({ success: true });
  }

  /** 清空审计明细并写入墓碑；重置 audit_bytes。手动清空与到期自动清理共用。 */
  private async purgeAuditContent(share: ShareStateRow, eventType: string): Promise<void> {
    const occurredAt = Date.now();
    this.db.exec('DELETE FROM audit_events');
    this.db.exec('UPDATE share_state SET audit_bytes = 0');
    await this.appendAudit(eventType, {}, occurredAt);
    await this.notifyOwnerAuditPurged(
      share,
      eventType === 'share.audit_auto_purged' ? 'auto' : 'manual',
      occurredAt
    );
  }

  /** 尽力同步清理留痕到所有者 UserDBDO（管理端集中展示）；失败不影响已完成的清理。 */
  private async notifyOwnerAuditPurged(
    share: ShareStateRow,
    purgeType: 'manual' | 'auto',
    occurredAt: number
  ): Promise<void> {
    try {
      const stub = this.env.USER_DB.get(this.env.USER_DB.idFromName(share.owner_github_id));
      const response = await stub.fetch(
        new Request(`http://internal/internal/shares/${share.share_id}/audit-purged`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: share.owner_user_id,
            purged_at: occurredAt,
            purge_type: purgeType,
          }),
        })
      );
      if (!response.ok) {
        console.error('SSHShareDO: failed to sync audit purge trace:', response.status);
      }
    } catch (error) {
      console.error('SSHShareDO: failed to sync audit purge trace:', error);
    }
  }

  private ownerView(ownerUserId: number, after: number, limit: number): Response {
    const share = this.getShare();
    if (!share || share.owner_user_id !== ownerUserId) return jsonError('Forbidden', 403);
    // 清理墓碑事件（purgeAuditContent 写入的两种 event_type）不进入常规列表，
    // 单独作为 removals 返回供前端折叠面板展示；SQL 字面量为编译期常量。
    const events = this.db
      .exec(
        `SELECT id, occurred_at, event_type, details FROM audit_events
       WHERE id > ?
         AND event_type NOT IN ('share.audit_purged', 'share.audit_auto_purged')
       ORDER BY id ASC LIMIT ?`,
        after,
        limit + 1
      )
      .toArray() as Array<{ id: number; occurred_at: number; event_type: string; details: string }>;
    const removalRows = this.db
      .exec(
        `SELECT occurred_at, event_type FROM audit_events
       WHERE event_type IN ('share.audit_purged', 'share.audit_auto_purged')
       ORDER BY occurred_at DESC`
      )
      .toArray() as Array<{ occurred_at: number; event_type: string }>;
    const hasMore = events.length > limit;
    const visible = events.slice(0, limit).map((event) => ({
      id: event.id,
      occurredAt: event.occurred_at,
      eventType: event.event_type,
      details: safeParseDetails(event.details),
    }));
    return Response.json({
      share: {
        id: share.share_id,
        serverName: share.server_name,
        status: share.status,
        expiresAt: share.expires_at,
        claimedAt: share.claimed_at,
        activeAt: share.active_at,
        closedAt: share.closed_at,
        sessionExpiresAt: share.session_expires_at,
        auditBytes: share.audit_bytes,
      },
      events: visible,
      removals: removalRows.map((row) => ({
        occurredAt: row.occurred_at,
        eventType: row.event_type,
      })),
      hasMore,
      nextAfter: visible.at(-1)?.id ?? after,
    });
  }

  private getShare(): ShareStateRow | null {
    const rows = this.db.exec('SELECT * FROM share_state WHERE singleton = 1').toArray();
    return rows.length ? (rows[0] as ShareStateRow) : null;
  }

  private async updateStatus(
    share: ShareStateRow,
    status: ShareStatus,
    closedAt: number
  ): Promise<void> {
    this.db.exec(
      `UPDATE share_state SET status = ?, closed_at = ?, ticket_hash = NULL,
       ticket_expires_at = NULL WHERE singleton = 1`,
      status,
      closedAt
    );
    share.status = status;
    share.closed_at = closedAt;
    // 终态进入审计保留期：到期自动清理调度；无审计明细则跳过
    if (TERMINAL_SHARE_STATUSES.has(status)) {
      const count = Number(this.db.exec('SELECT COUNT(*) AS count FROM audit_events').one().count);
      if (count > 0) {
        const retentionDays = share.audit_retention_days ?? DEFAULT_AUDIT_RETENTION_DAYS;
        const due = Date.now() + retentionDays * MS_PER_DAY;
        this.db.exec('UPDATE share_state SET audit_purge_due = ?', due);
        try {
          await this.state.storage.setAlarm(due);
          share.audit_purge_due = due;
        } catch (error) {
          // 排期失败必须回滚：否则库里留下“有排期但无闹钟”的幽灵状态，自动清理将永不触发
          console.error('SSHShareDO: failed to schedule audit purge alarm:', error);
          this.db.exec('UPDATE share_state SET audit_purge_due = NULL');
          share.audit_purge_due = null;
        }
      }
    }
  }

  private async appendAudit(
    eventType: string,
    details: unknown,
    occurredAt = Date.now(),
    knownByteSize?: number
  ): Promise<void> {
    const serialized = JSON.stringify(details ?? {});
    const byteSize = knownByteSize ?? new TextEncoder().encode(serialized).length;
    this.db.exec(
      'INSERT INTO audit_events (occurred_at, event_type, details, byte_size) VALUES (?, ?, ?, ?)',
      occurredAt,
      eventType,
      serialized,
      byteSize
    );
    this.db.exec(
      'UPDATE share_state SET audit_bytes = audit_bytes + ? WHERE singleton = 1',
      byteSize
    );
  }

  private async syncOwnerMetadata(
    share: ShareStateRow,
    status: ShareStatus,
    times: { claimedAt?: number; activeAt?: number; closedAt?: number }
  ): Promise<void> {
    const stub = this.env.USER_DB.get(this.env.USER_DB.idFromName(share.owner_github_id));
    await stub
      .fetch(
        new Request(`http://internal/internal/shares/${share.share_id}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: share.owner_user_id,
            status,
            claimed_at: times.claimedAt,
            active_at: times.activeAt,
            closed_at: times.closedAt,
          }),
        })
      )
      .catch(() => null);
  }

  private async scheduleNextAlarm(share: ShareStateRow): Promise<void> {
    const candidates = [share.expires_at, share.session_expires_at].filter(
      (value): value is number => typeof value === 'number' && value > Date.now()
    );
    if (candidates.length > 0) await this.state.storage.setAlarm(Math.min(...candidates));
  }
}
