import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));

vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import type { Env } from '../../src/types';
import { UserDBDO } from '../../src/worker/user-db';

interface CheckpointRowRecord {
  id: number;
  user_id: number;
  server_id: number;
  title: string;
  status: string;
  done_summary: string;
  next_step: string;
  created_at: number;
  updated_at: number;
}

class FakeSql {
  checkpoints: CheckpointRowRecord[] = [];
  servers: Array<{ id: number; user_id: number; name: string }> = [
    { id: 1, user_id: 10, name: 'Prod Server' },
    { id: 2, user_id: 20, name: 'Other User Server' },
  ];
  private nextId = 1;
  statements: Array<{ query: string; values: unknown[] }> = [];

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });
    const q = query.replace(/\s+/g, ' ');

    if (
      q.includes('CREATE TABLE') ||
      q.includes('CREATE INDEX') ||
      q.includes('PRAGMA table_info')
    ) {
      if (q.includes('PRAGMA table_info(servers)')) {
        return { toArray: () => [{ name: 'region' }, { name: 'inferred_hint' }] as unknown[] };
      }
      return { toArray: () => [] };
    }

    if (q.includes('SELECT user_id FROM servers WHERE id = ?')) {
      const serverId = values[0];
      const s = this.servers.find((srv) => srv.id === serverId);
      return { toArray: () => (s ? [{ user_id: s.user_id }] : []) };
    }

    if (q.includes('FROM servers WHERE id = ?')) {
      const serverId = values[0];
      const s = this.servers.find((srv) => srv.id === serverId);
      if (!s) return { toArray: () => [] };
      return {
        toArray: () => [
          {
            id: s.id,
            user_id: s.user_id,
            name: s.name,
            host: '1.2.3.4',
            port: 22,
            username: 'root',
            auth_method: 'password',
            region: null,
            inferred_hint: null,
            tags: '[]',
            os: null,
            jump_server_id: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ],
      };
    }

    if (q.startsWith('UPDATE servers SET')) {
      return { toArray: () => [] };
    }

    if (q.includes('FROM server_task_checkpoints WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1')) {
      const [serverId, userId] = values as [number, number];
      const rows = this.checkpoints
        .filter((c) => c.server_id === serverId && c.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at);
      return { toArray: () => (rows.length > 0 ? [rows[0]] : []) as unknown[] };
    }

    if (q.includes('FROM server_task_checkpoints WHERE server_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?')) {
      const [serverId, userId, limit] = values as [number, number, number];
      const rows = this.checkpoints
        .filter((c) => c.server_id === serverId && c.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      return { toArray: () => rows as unknown[] };
    }

    if (q.includes('SELECT id, user_id FROM server_task_checkpoints WHERE id = ? AND server_id = ?') ||
        q.includes('SELECT user_id FROM server_task_checkpoints WHERE id = ? AND server_id = ?')) {
      const [id, serverId] = values as [number, number];
      const found = this.checkpoints.filter((c) => c.id === id && c.server_id === serverId);
      return { toArray: () => found as unknown[] };
    }

    if (q.startsWith('INSERT INTO server_task_checkpoints')) {
      const [userId, serverId, title, status, doneSummary, nextStep, createdAt, updatedAt] =
        values as [number, number, string, string, string, string, number, number];

      const row: CheckpointRowRecord = {
        id: this.nextId++,
        user_id: userId,
        server_id: serverId,
        title,
        status,
        done_summary: doneSummary,
        next_step: nextStep,
        created_at: createdAt,
        updated_at: updatedAt,
      };
      this.checkpoints.push(row);
      return { toArray: () => [] };
    }

    if (q.startsWith('UPDATE server_task_checkpoints SET title = ?, status = ?, done_summary = ?, next_step = ?, updated_at = ?')) {
      const [title, status, doneSummary, nextStep, updatedAt, targetId, serverId, userId] =
        values as [string, string, string, string, number, number, number, number];
      const idx = this.checkpoints.findIndex(
        (c) => c.id === targetId && c.server_id === serverId && c.user_id === userId
      );
      if (idx >= 0) {
        this.checkpoints[idx] = {
          ...this.checkpoints[idx],
          title,
          status,
          done_summary: doneSummary,
          next_step: nextStep,
          updated_at: updatedAt,
        };
      }
      return { toArray: () => [] };
    }

    if (q.startsWith('UPDATE server_task_checkpoints SET status = ?, updated_at = ? WHERE id = ?')) {
      const [status, updatedAt, chkId] = values as [string, number, number];
      const idx = this.checkpoints.findIndex((c) => c.id === chkId);
      if (idx >= 0) {
        this.checkpoints[idx] = {
          ...this.checkpoints[idx],
          status,
          updated_at: updatedAt,
        };
      }
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_task_checkpoints WHERE server_id = ? AND user_id = ? AND id NOT IN')) {
      const [serverId, userId] = values as [number, number];
      const serverCps = this.checkpoints
        .filter((c) => c.server_id === serverId && c.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at);
      const keepIds = new Set(serverCps.slice(0, 5).map((c) => c.id));
      this.checkpoints = this.checkpoints.filter(
        (c) => !(c.server_id === serverId && c.user_id === userId && !keepIds.has(c.id))
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_task_checkpoints WHERE id = ? AND server_id = ? AND user_id = ?')) {
      const [id, serverId, userId] = values as [number, number, number];
      this.checkpoints = this.checkpoints.filter(
        (c) => !(c.id === id && c.server_id === serverId && c.user_id === userId)
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_task_checkpoints WHERE server_id = ?')) {
      const serverId = values[0];
      this.checkpoints = this.checkpoints.filter((c) => c.server_id !== serverId);
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }
}

describe('UserDBDO server task checkpoints', () => {
  let fakeSql: FakeSql;
  let userDb: UserDBDO;

  beforeEach(() => {
    fakeSql = new FakeSql();
    userDb = new UserDBDO(
      {
        storage: {
          sql: fakeSql,
          get: vi.fn(),
          put: vi.fn(),
          delete: vi.fn(),
        },
      } as never,
      {} as Env
    );
  });

  it('lists server checkpoints with ownership enforcement', async () => {
    // Other user's server -> 403
    const resForbidden = await userDb.fetch(
      new Request('http://internal/internal/servers/2/checkpoints?user_id=10')
    );
    expect(resForbidden.status).toBe(403);

    // Non-existent server -> 404
    const resNotFound = await userDb.fetch(
      new Request('http://internal/internal/servers/999/checkpoints?user_id=10')
    );
    expect(resNotFound.status).toBe(404);

    // Owned server -> 200
    const res = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints?user_id=10')
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it('saves and updates a task checkpoint with validation', async () => {
    // Missing fields -> 400
    const resEmpty = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10, title: '' }),
      })
    );
    expect(resEmpty.status).toBe(400);

    // Sensitive data -> 400
    const resSensitive = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          title: '排查数据库',
          done_summary: 'password=supersecret',
          next_step: '重试登录',
        }),
      })
    );
    expect(resSensitive.status).toBe(400);
    const sensitiveErr = (await resSensitive.json()) as { error: string };
    expect(sensitiveErr.error).toContain('敏感凭据');

    // Valid checkpoint -> 201
    const resCreate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          title: '排查 502 错误',
          status: 'in_progress',
          done_summary: '已定位为 3000 端口 Node 挂掉，重启了服务',
          next_step: '待 curl 探测接口恢复',
        }),
      })
    );
    expect(resCreate.status).toBe(201);
    const created = (await resCreate.json()) as CheckpointRowRecord;
    expect(created.title).toBe('排查 502 错误');
    expect(created.status).toBe('in_progress');
    expect(created.done_summary).toBe('已定位为 3000 端口 Node 挂掉，重启了服务');

    // Update same in-progress task in next turn
    const resUpdate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          title: '排查 502 错误',
          status: 'completed',
          done_summary: '已定位为 3000 端口 Node 挂掉并重启，已验证 curl 200 OK',
          next_step: '故障已彻底消除',
        }),
      })
    );
    expect(resUpdate.status).toBe(201);
    const updated = (await resUpdate.json()) as CheckpointRowRecord;
    expect(updated.status).toBe('completed');
    expect(updated.done_summary).toContain('已验证 curl 200 OK');
    // Should update existing in-place rather than add duplicate
    expect(fakeSql.checkpoints).toHaveLength(1);
  });

  it('updates checkpoint status via PUT', async () => {
    // Create checkpoint
    const resCreate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          title: '排查服务崩溃',
          status: 'in_progress',
          done_summary: '重启中',
          next_step: '等待恢复',
        }),
      })
    );
    const created = (await resCreate.json()) as CheckpointRowRecord;

    // Update status to completed
    const resPut = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/checkpoints/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10, status: 'completed' }),
      })
    );
    expect(resPut.status).toBe(200);
    expect(fakeSql.checkpoints[0].status).toBe('completed');
  });

  it('deletes a checkpoint with ownership check', async () => {
    // Create checkpoint
    const resCreate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          title: '排查内存占用',
          status: 'in_progress',
          done_summary: '发现僵尸进程',
          next_step: '杀掉僵尸进程',
        }),
      })
    );
    const created = (await resCreate.json()) as CheckpointRowRecord;

    // Delete with wrong user -> 403
    const resForbidden = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/checkpoints/${created.id}?user_id=99`, {
        method: 'DELETE',
      })
    );
    expect(resForbidden.status).toBe(403);

    // Delete with owner -> 200
    const resDel = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/checkpoints/${created.id}?user_id=10`, {
        method: 'DELETE',
      })
    );
    expect(resDel.status).toBe(200);

    // Verify deleted
    const resList = await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints?user_id=10')
    );
    const data = await resList.json();
    expect(data).toHaveLength(0);
  });

  it('clears checkpoints when server host or port changes', async () => {
    // Add a checkpoint
    await userDb.fetch(
      new Request('http://internal/internal/servers/1/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          title: '检查网络',
          status: 'in_progress',
          done_summary: '已测试 ping',
          next_step: '测试 traceroute',
        }),
      })
    );
    expect(fakeSql.checkpoints).toHaveLength(1);

    // Update server host -> checkpoints cleared
    const resUpdate = await userDb.fetch(
      new Request('http://internal/internal/servers/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          host: '5.6.7.8',
        }),
      })
    );
    expect(resUpdate.status).toBe(200);
    expect(fakeSql.checkpoints).toHaveLength(0);
  });
});
