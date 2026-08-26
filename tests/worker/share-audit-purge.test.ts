import { describe, expect, it, vi } from 'vitest';
import { SSHShareDO } from '../../src/worker/share-do';
import { UserDBDO } from '../../src/worker/user-db';

// ==================== SSHShareDO 侧：内存伪 SQL ====================

interface FakeAuditEvent {
  id: number;
  occurred_at: number;
  event_type: string;
  details: string;
  byte_size: number;
}

function seedShare(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    singleton: 1,
    share_id: 'share-1',
    token_hash: 'token-hash',
    owner_user_id: 7,
    owner_github_id: 'gh-7',
    server_id: 1,
    server_name: 'srv-1',
    expires_at: Date.now() - 60_000,
    max_session_seconds: 600,
    status: 'closed',
    claimed_at: 1000,
    active_at: 2000,
    closed_at: 3000,
    session_expires_at: null,
    session_name: null,
    ticket_hash: null,
    ticket_expires_at: null,
    audit_bytes: 500,
    device_pub_key: null,
    audit_purge_due: null,
    audit_retention_days: 30,
    ...overrides,
  };
}

class ShareFakeSql {
  share: Record<string, unknown> | null;
  events: FakeAuditEvent[];
  calls: string[] = [];
  private nextId = 1;

  constructor(share: Record<string, unknown> | null, events: FakeAuditEvent[] = []) {
    this.share = share ? { ...share } : null;
    this.events = events.map((event) => ({ ...event }));
  }

  exec(sql: string, ...values: unknown[]): { toArray: () => unknown[]; one: () => unknown } {
    this.calls.push(sql);
    const tableRead = {
      toArray: () => [] as unknown[],
      one: () => ({}) as unknown,
    };

    if (sql.includes('SELECT * FROM share_state WHERE singleton = 1')) {
      return { toArray: () => (this.share ? [{ ...this.share }] : []), one: () => ({}) };
    }
    if (sql.includes('SELECT COUNT(*) AS count FROM audit_events')) {
      return { toArray: () => [], one: () => ({ count: this.events.length }) };
    }
    if (sql.includes('event_type NOT IN')) {
      const after = Number(values[0]);
      const limit = Number(values[1]);
      const rows = this.events
        .filter(
          (event) =>
            event.id > after &&
            event.event_type !== 'share.audit_purged' &&
            event.event_type !== 'share.audit_auto_purged'
        )
        .slice(0, limit);
      return { toArray: () => rows, one: () => ({}) };
    }
    if (sql.includes('WHERE event_type IN')) {
      const rows = this.events.filter(
        (event) =>
          event.event_type === 'share.audit_purged' ||
          event.event_type === 'share.audit_auto_purged'
      );
      return { toArray: () => rows, one: () => ({}) };
    }
    if (sql.includes('DELETE FROM audit_events')) {
      this.events = [];
      return tableRead;
    }
    if (sql.includes('UPDATE share_state SET audit_bytes = 0')) {
      if (this.share) this.share.audit_bytes = 0;
      return tableRead;
    }
    if (sql.includes('UPDATE share_state SET audit_bytes = audit_bytes +')) {
      if (this.share) this.share.audit_bytes = Number(this.share.audit_bytes ?? 0) + Number(values[0]);
      return tableRead;
    }
    if (sql.includes('UPDATE share_state SET audit_purge_due = NULL')) {
      if (this.share) this.share.audit_purge_due = null;
      return tableRead;
    }
    if (sql.includes('UPDATE share_state SET audit_purge_due = ?')) {
      if (this.share) this.share.audit_purge_due = Number(values[0]);
      return tableRead;
    }
    if (sql.includes('UPDATE share_state SET status = ?')) {
      if (this.share) {
        this.share.status = String(values[0]);
        this.share.closed_at = Number(values[1]);
      }
      return tableRead;
    }
    if (sql.includes('INSERT INTO audit_events')) {
      this.events.push({
        id: this.nextId++,
        occurred_at: Number(values[0]),
        event_type: String(values[1]),
        details: String(values[2]),
        byte_size: Number(values[3]),
      });
      return tableRead;
    }
    if (sql.startsWith('CREATE') || sql.startsWith('ALTER')) {
      // 建表/迁移语句：伪 SQL 中直接忽略
      return tableRead;
    }
    return tableRead;
  }
}

function makeShareDo(options: {
  share: Record<string, unknown> | null;
  events?: FakeAuditEvent[];
  userDbFetch?: (request: Request) => Promise<Response> | Response;
  deleteAlarm?: () => Promise<void>;
}): {
  doInstance: SSHShareDO;
  fakeSql: ShareFakeSql;
  userDbFetch: ReturnType<typeof vi.fn>;
  deleteAlarm: ReturnType<typeof vi.fn>;
} {
  const fakeSql = new ShareFakeSql(options.share, options.events ?? []);
  const userDbFetch = vi.fn(
    options.userDbFetch ?? (async () => new Response('{}', { status: 200 }) as Response)
  );
  const deleteAlarm = vi.fn(options.deleteAlarm ?? (async () => {}));
  const state = {
    storage: {
      sql: fakeSql,
      setAlarm: vi.fn(async () => {}),
      deleteAlarm,
    },
  };
  const env = {
    USER_DB: {
      get: vi.fn(() => ({ fetch: userDbFetch })),
      idFromName: vi.fn((name: string) => name),
    },
  };
  const doInstance = new SSHShareDO(state as unknown as DurableObjectState, env as never);
  return { doInstance, fakeSql, userDbFetch, deleteAlarm };
}

function ownerViewRequest(ownerUserId: number): Request {
  return new Request(
    `http://internal/internal/owner-view?owner_user_id=${ownerUserId}&after=0&limit=500`,
    { method: 'GET' }
  );
}

function purgeRequest(ownerUserId: number): Request {
  return new Request('http://internal/internal/audit/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerUserId }),
  });
}

async function readOwnerView(response: Response): Promise<{
  share: { auditBytes: number; status: string };
  events: Array<{ eventType: string }>;
  removals: Array<{ occurredAt: number; eventType: string }>;
}> {
  return (await response.json()) as {
    share: { auditBytes: number; status: string };
    events: Array<{ eventType: string }>;
    removals: Array<{ occurredAt: number; eventType: string }>;
  };
}

describe('SSHShareDO 审计清理留痕', () => {
  const sampleEvents: FakeAuditEvent[] = [
    { id: 1, occurred_at: 1000, event_type: 'share.claimed', details: '{}', byte_size: 2 },
    { id: 2, occurred_at: 2000, event_type: 'session.connecting', details: '{}', byte_size: 2 },
    { id: 3, occurred_at: 3000, event_type: 'terminal.output', details: '{}', byte_size: 2 },
  ];

  it('手动清空后：墓碑不进常规事件列表，removals 返回 1 条，audit_bytes 归零', async () => {
    const { doInstance } = makeShareDo({ share: seedShare(), events: sampleEvents });
    const purge = await doInstance.fetch(purgeRequest(7));
    expect(purge.status).toBe(200);

    const view = await readOwnerView(await doInstance.fetch(ownerViewRequest(7)));
    // 清理后 audit_bytes 归零后仅剩墓碑本身（'{}' 恰为 2 字节）
    expect(view.share.auditBytes).toBe(2);
    expect(view.events).toHaveLength(0);
    expect(view.events.some((event) => event.eventType === 'share.audit_purged')).toBe(false);
    expect(view.removals).toHaveLength(1);
    expect(view.removals[0].eventType).toBe('share.audit_purged');
  });

  it('手动清空失败时不产生任何清理留痕（归属校验 403、非终态 409）', async () => {
    const { doInstance } = makeShareDo({ share: seedShare(), events: sampleEvents });
    expect((await doInstance.fetch(purgeRequest(8))).status).toBe(403);
    expect((await doInstance.fetch(purgeRequest(7))).status).toBe(200);

    const unused = makeShareDo({
      share: seedShare({ status: 'unused', server_name: 'srv-x' }),
      events: [],
    });
    expect((await unused.doInstance.fetch(purgeRequest(7))).status).toBe(409);
  });

  it('部署窗口期 UserDBDO 同步失败不影响清理成功（尽力而为）', async () => {
    const { doInstance } = makeShareDo({
      share: seedShare(),
      events: sampleEvents,
      userDbFetch: async () => {
        throw new Error('old UserDBDO: route not found');
      },
    });
    const purge = await doInstance.fetch(purgeRequest(7));
    expect(purge.status).toBe(200);
    const view = await readOwnerView(await doInstance.fetch(ownerViewRequest(7)));
    expect(view.removals).toHaveLength(1);
    expect(view.removals[0].eventType).toBe('share.audit_purged');
  });

  it('到期自动清理：走 alarm 路径、写 auto 墓碑、清空 purge_due 并同步 auto 留痕', async () => {
    const { doInstance, userDbFetch } = makeShareDo({
      share: seedShare({ audit_purge_due: Date.now() - 1000 }),
      events: sampleEvents,
    });
    await doInstance.alarm();

    const view = await readOwnerView(await doInstance.fetch(ownerViewRequest(7)));
    expect(view.removals).toHaveLength(1);
    expect(view.removals[0].eventType).toBe('share.audit_auto_purged');
    // 清除后仅剩自动清理墓碑自身的字节数
    expect(view.share.auditBytes).toBe(2);

    // notifyOwnerAuditPurged 应以 auto 方式同步到 UserDBDO
    expect(userDbFetch).toHaveBeenCalledTimes(1);
    const [callRequest] = userDbFetch.mock.calls[0] as [Request];
    expect(callRequest.url).toContain('/internal/shares/share-1/audit-purged');
    const callBody = JSON.parse(await callRequest.text()) as { purge_type: string };
    expect(callBody.purge_type).toBe('auto');
  });

  it('updateStatus 排期闹钟失败时回滚 audit_purge_due（修复幽灵状态）', async () => {
    const { doInstance, fakeSql } = makeShareDo({
      share: seedShare({ status: 'claimed', session_expires_at: 1, audit_retention_days: 30 }),
      events: sampleEvents,
    });
    // setAlarm 拒绝：模拟闹钟设置静默失败
    const state = (doInstance as unknown as { state: { storage: { setAlarm: ReturnType<typeof vi.fn> } } })
      .state;
    state.storage.setAlarm = vi.fn(async () => {
      throw new Error('alarm quota exceeded');
    });
    const res = await doInstance.fetch(
      new Request('http://internal/internal/session/closed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ normal: true }),
      })
    );
    expect(res.status).toBe(200);
    // 失败必须回滚：库里不留“有排期但无闹钟”的幽灵状态
    expect(fakeSql.share?.status).toBe('closed');
    expect(fakeSql.share?.audit_purge_due).toBeNull();
  });
});

// ==================== UserDBDO 侧 ====================

class UserDbFakeSql {
  shareColumns: string[];
  serverColumns = ['region', 'inferred_hint', 'tags', 'os', 'jump_server_id'];
  shareRows: Array<{ user_id: number }>;
  updates: Array<{ sql: string; values: unknown[] }> = [];

  constructor(shareColumns: string[], shareRows: Array<{ user_id: number }> = []) {
    this.shareColumns = shareColumns;
    this.shareRows = shareRows;
  }

  exec(sql: string, ...values: unknown[]): { toArray: () => unknown[]; one: () => unknown } {
    if (sql.includes('PRAGMA table_info(servers)')) {
      return { toArray: () => this.serverColumns.map((name) => ({ name })), one: () => ({}) };
    }
    if (sql.includes('PRAGMA table_info(ssh_shares)')) {
      return { toArray: () => this.shareColumns.map((name) => ({ name })), one: () => ({}) };
    }
    if (sql === 'SELECT user_id FROM ssh_shares WHERE id = ?') {
      return { toArray: () => this.shareRows, one: () => ({}) };
    }
    if (sql.startsWith('ALTER TABLE ssh_shares')) {
      this.updates.push({ sql, values });
      return { toArray: () => [], one: () => ({}) };
    }
    if (sql.startsWith('UPDATE ssh_shares SET audit_purged_at')) {
      this.updates.push({ sql, values });
      return { toArray: () => [], one: () => ({}) };
    }
    return { toArray: () => [], one: () => ({}) };
  }
}

function makeUserDb(sql: UserDbFakeSql): UserDBDO {
  return new UserDBDO(
    { storage: { sql } } as unknown as DurableObjectState,
    {} as never
  );
}

function auditPurgedRequest(body: unknown): Request {
  return new Request('http://internal/internal/shares/share-1/audit-purged', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('UserDBDO 审计清理留痕接缝', () => {
  it('同步留痕：归属匹配时更新 audit_purged_at/audit_purge_type', async () => {
    const sql = new UserDbFakeSql(
      ['id', 'user_id', 'audit_purged_at', 'audit_purge_type'],
      [{ user_id: 7 }]
    );
    const db = makeUserDb(sql);
    const res = await db.fetch(
      auditPurgedRequest({ user_id: 7, purged_at: 123456, purge_type: 'manual' })
    );
    expect(res.status).toBe(200);
    expect(sql.updates).toHaveLength(1);
    expect(sql.updates[0].values).toEqual([123456, 'manual', 'share-1']);
  });

  it('归属不匹配拒绝写入（403），非法 purge_type 拒绝（400）', async () => {
    const sql = new UserDbFakeSql(
      ['id', 'user_id', 'audit_purged_at', 'audit_purge_type'],
      [{ user_id: 7 }]
    );
    const db = makeUserDb(sql);
    expect((await db.fetch(auditPurgedRequest({ user_id: 8, purged_at: 1, purge_type: 'manual' }))).status).toBe(403);
    expect((await db.fetch(auditPurgedRequest({ user_id: 7, purged_at: 1, purge_type: 'manual' }))).status).toBe(200);
    const sql2 = new UserDbFakeSql(['id', 'user_id'], [{ user_id: 7 }]);
    const db2 = makeUserDb(sql2);
    expect((await db2.fetch(auditPurgedRequest({ user_id: 7, purged_at: 1, purge_type: 'weird' }))).status).toBe(400);
    expect((await db2.fetch(auditPurgedRequest({ user_id: '7', purged_at: 1, purge_type: 'manual' }))).status).toBe(400);
    expect((await db2.fetch(auditPurgedRequest({ user_id: 7, purged_at: Number.NaN, purge_type: 'manual' }))).status).toBe(400);
  });

  it('ssh_shares audit 留痕迁移幂等：缺列时补列，已有时不再 ALTER', async () => {
    const oldSql = new UserDbFakeSql(['id', 'user_id'], []);
    makeUserDb(oldSql);
    const alterCount = oldSql.updates.filter((update) => update.sql.startsWith('ALTER')).length;
    expect(alterCount).toBe(2); // audit_purged_at + audit_purge_type

    const newSql = new UserDbFakeSql(['id', 'user_id', 'audit_purged_at', 'audit_purge_type'], []);
    makeUserDb(newSql);
    expect(newSql.updates.filter((update) => update.sql.startsWith('ALTER')).length).toBe(0);
  });
});
