import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));

vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import type { Env } from '../../src/types';
import { UserDBDO } from '../../src/worker/user-db';

interface WorkLogRowRecord {
  id: number;
  user_id: number;
  server_id: number;
  title: string;
  summary: string;
  created_at: number;
  updated_at: number;
}

interface KnowledgeRowRecord {
  id: number;
  user_id: number;
  server_id: number;
  category: string;
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

class FakeSql {
  workLogs: WorkLogRowRecord[] = [];
  knowledge: KnowledgeRowRecord[] = [];
  servers: Array<{ id: number; user_id: number; name: string }> = [
    { id: 1, user_id: 10, name: 'Prod Server' },
    { id: 2, user_id: 20, name: 'Other User Server' },
  ];
  private nextLogId = 1;
  private nextKnowledgeId = 1;
  statements: Array<{ query: string; values: unknown[] }> = [];

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });
    const q = query.replace(/\s+/g, ' ');

    if (
      q.includes('CREATE TABLE') ||
      q.includes('CREATE INDEX') ||
      q.includes('PRAGMA table_info') ||
      q.includes('DROP TABLE')
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

    // Work logs query
    if (q.includes('FROM server_work_logs WHERE server_id = ? AND user_id = ?')) {
      const [serverId, userId] = values as [number, number];
      const rows = this.workLogs
        .filter((l) => l.server_id === serverId && l.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at);
      return { toArray: () => rows as unknown[] };
    }

    if (q.includes('SELECT user_id FROM server_work_logs WHERE id = ? AND server_id = ?')) {
      const [id, serverId] = values as [number, number];
      const found = this.workLogs.filter((l) => l.id === id && l.server_id === serverId);
      return { toArray: () => found as unknown[] };
    }

    if (q.includes('SELECT id FROM server_work_logs') && q.includes('ORDER BY updated_at DESC LIMIT 1')) {
      const [serverId, userId] = values as [number, number];
      const sorted = this.workLogs
        .filter((l) => l.server_id === serverId && l.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at);
      return { toArray: () => (sorted.length > 0 ? [{ id: sorted[0].id }] : []) };
    }

    if (q.startsWith('UPDATE server_work_logs SET title = ?, summary = ?, updated_at = ? WHERE id = ?')) {
      const [title, summary, updatedAt, id] = values as [string, string, number, number];
      const idx = this.workLogs.findIndex((l) => l.id === id);
      if (idx >= 0) {
        this.workLogs[idx] = { ...this.workLogs[idx], title, summary, updated_at: updatedAt };
      }
      return { toArray: () => [] };
    }

    if (q.startsWith('INSERT INTO server_work_logs')) {
      const [userId, serverId, title, summary, createdAt, updatedAt] = values as [
        number,
        number,
        string,
        string,
        number,
        number,
      ];
      const row: WorkLogRowRecord = {
        id: this.nextLogId++,
        user_id: userId,
        server_id: serverId,
        title,
        summary,
        created_at: createdAt,
        updated_at: updatedAt,
      };
      this.workLogs.push(row);
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_work_logs WHERE id = ? AND server_id = ?')) {
      const [id, serverId, userId] = values as [number, number, number];
      this.workLogs = this.workLogs.filter(
        (l) => !(l.id === id && l.server_id === serverId && l.user_id === userId)
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_work_logs WHERE server_id = ? AND user_id = ? AND id NOT IN')) {
      const [serverId, userId] = values as [number, number];
      const sLogs = this.workLogs
        .filter((l) => l.server_id === serverId && l.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at);
      const keep = new Set(sLogs.slice(0, 10).map((l) => l.id));
      this.workLogs = this.workLogs.filter(
        (l) => !(l.server_id === serverId && l.user_id === userId && !keep.has(l.id))
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_work_logs WHERE server_id = ?')) {
      const serverId = values[0];
      this.workLogs = this.workLogs.filter((l) => l.server_id !== serverId);
      return { toArray: () => [] };
    }

    // Knowledge query
    if (q.includes('FROM server_knowledge WHERE server_id = ? AND user_id = ? AND key = ?')) {
      const [serverId, userId, key] = values as [number, number, string];
      const rows = this.knowledge.filter(
        (k) => k.server_id === serverId && k.user_id === userId && k.key === key
      );
      return { toArray: () => rows as unknown[] };
    }

    if (q.includes('FROM server_knowledge WHERE server_id = ? AND user_id = ?')) {
      const [serverId, userId] = values as [number, number];
      const rows = this.knowledge
        .filter((k) => k.server_id === serverId && k.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at);
      return { toArray: () => rows as unknown[] };
    }

    if (q.includes('SELECT user_id FROM server_knowledge WHERE id = ? AND server_id = ?')) {
      const [id, serverId] = values as [number, number];
      const found = this.knowledge.filter((k) => k.id === id && k.server_id === serverId);
      return { toArray: () => found as unknown[] };
    }

    if (q.startsWith('DELETE FROM server_knowledge WHERE user_id = ? AND server_id = ? AND key = ?')) {
      const [userId, serverId, key] = values as [number, number, string];
      this.knowledge = this.knowledge.filter(
        (k) => !(k.user_id === userId && k.server_id === serverId && k.key === key)
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('INSERT INTO server_knowledge')) {
      const [userId, serverId, category, key, value, createdAt, updatedAt] = values as [
        number,
        number,
        string,
        string,
        string,
        number,
        number,
      ];
      const existingIdx = this.knowledge.findIndex(
        (k) => k.user_id === userId && k.server_id === serverId && k.key === key
      );
      if (existingIdx >= 0) {
        this.knowledge[existingIdx] = {
          ...this.knowledge[existingIdx],
          category,
          value,
          updated_at: updatedAt,
        };
      } else {
        const row: KnowledgeRowRecord = {
          id: this.nextKnowledgeId++,
          user_id: userId,
          server_id: serverId,
          category,
          key,
          value,
          created_at: createdAt,
          updated_at: updatedAt,
        };
        this.knowledge.push(row);
      }
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_knowledge WHERE id = ? AND server_id = ?')) {
      const [id, serverId, userId] = values as [number, number, number];
      this.knowledge = this.knowledge.filter(
        (k) => !(k.id === id && k.server_id === serverId && k.user_id === userId)
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_knowledge WHERE server_id = ? AND user_id = ? AND id NOT IN')) {
      const [serverId, userId] = values as [number, number];
      const sK = this.knowledge
        .filter((k) => k.server_id === serverId && k.user_id === userId)
        .sort((a, b) => b.updated_at - a.updated_at);
      const keep = new Set(sK.slice(0, 50).map((k) => k.id));
      this.knowledge = this.knowledge.filter(
        (k) => !(k.server_id === serverId && k.user_id === userId && !keep.has(k.id))
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_knowledge WHERE server_id = ?')) {
      const serverId = values[0];
      this.knowledge = this.knowledge.filter((k) => k.server_id !== serverId);
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM servers WHERE id = ?')) {
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }
}

describe('UserDBDO unified server memory', () => {
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

  it('fetches server memory with ownership enforcement', async () => {
    // Other user's server -> 403
    const resForbidden = await userDb.fetch(
      new Request('http://internal/internal/servers/2/memory?user_id=10')
    );
    expect(resForbidden.status).toBe(403);

    // Non-existent server -> 404
    const resNotFound = await userDb.fetch(
      new Request('http://internal/internal/servers/999/memory?user_id=10')
    );
    expect(resNotFound.status).toBe(404);

    // Owned server -> 200
    const res = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memory?user_id=10')
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { workLogs: unknown[]; knowledge: unknown[] };
    expect(data.workLogs).toHaveLength(0);
    expect(data.knowledge).toHaveLength(0);
  });

  it('saves and deletes a work log', async () => {
    // Valid work log -> 201
    const resCreate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/work-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          title: '巡检服务器硬件',
          summary: 'CPU与内存占用正常',
        }),
      })
    );
    expect(resCreate.status).toBe(201);
    const created = (await resCreate.json()) as WorkLogRowRecord;
    expect(created.title).toBe('巡检服务器硬件');

    // Delete with wrong user -> 403
    const resForbidden = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/work-logs/${created.id}?user_id=99`, {
        method: 'DELETE',
      })
    );
    expect(resForbidden.status).toBe(403);

    // Delete with owner -> 200
    const resDel = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/work-logs/${created.id}?user_id=10`, {
        method: 'DELETE',
      })
    );
    expect(resDel.status).toBe(200);
    expect(fakeSql.workLogs).toHaveLength(0);
  });

  it('saves and deletes knowledge and credentials', async () => {
    // Save deploy token -> 201
    const resCreate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          category: 'credential',
          key: 'deploy_token',
          value: 'ghp_secret_token_123',
        }),
      })
    );
    expect(resCreate.status).toBe(201);
    const created = (await resCreate.json()) as KnowledgeRowRecord;
    expect(created.key).toBe('deploy_token');
    expect(created.value).toBe('ghp_secret_token_123');

    // Delete with owner -> 200
    const resDel = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/knowledge/${created.id}?user_id=10`, {
        method: 'DELETE',
      })
    );
    expect(resDel.status).toBe(200);
    expect(fakeSql.knowledge).toHaveLength(0);
  });

  it('supports batch delete of knowledge items', async () => {
    // 注入 3 条知识
    fakeSql.knowledge = [
      { id: 10, user_id: 10, server_id: 1, category: 'config', key: 'k1', value: 'v1', created_at: 1, updated_at: 1 },
      { id: 11, user_id: 10, server_id: 1, category: 'config', key: 'k2', value: 'v2', created_at: 1, updated_at: 1 },
      { id: 12, user_id: 10, server_id: 1, category: 'config', key: 'k3', value: 'v3', created_at: 1, updated_at: 1 },
    ];

    // 校验无效输入 -> 400
    const resInvalid = await userDb.fetch(
      new Request('http://internal/internal/servers/1/knowledge/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10, ids: [] }),
      })
    );
    expect(resInvalid.status).toBe(400);

    // 越权删除 -> 403
    const resForbidden = await userDb.fetch(
      new Request('http://internal/internal/servers/1/knowledge/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 999, ids: [10, 11] }),
      })
    );
    expect(resForbidden.status).toBe(403);

    // 批量删除 id=10, 11 -> 200
    const resBatch = await userDb.fetch(
      new Request('http://internal/internal/servers/1/knowledge/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10, ids: [10, 11] }),
      })
    );
    expect(resBatch.status).toBe(200);
    const data = await resBatch.json() as { success: boolean; count: number };
    expect(data.success).toBe(true);
    expect(data.count).toBe(2);

    expect(fakeSql.knowledge).toHaveLength(1);
    expect(fakeSql.knowledge[0].id).toBe(12);
  });

  it('handles batch save of memory from AI session', async () => {
    const resBatch = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memory/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          workLog: {
            title: '部署应用并更新配置',
            summary: '构建镜像并成功启动，端口正常监听',
          },
          knowledge: [
            { category: 'credential', key: 'api_token', value: 'sk-123456' },
            { category: 'config', key: 'app_port', value: '3000' },
          ],
        }),
      })
    );
    expect(resBatch.status).toBe(200);
    expect(fakeSql.workLogs).toHaveLength(1);
    expect(fakeSql.knowledge).toHaveLength(2);
  });

  it('supports update_latest mode for work log and delete action for knowledge in batch save', async () => {
    // 1. 先有一条工作日志和一条知识项
    fakeSql.workLogs = [
      {
        id: 101,
        user_id: 10,
        server_id: 1,
        title: '初始排查',
        summary: '正在检查端口',
        created_at: 1000,
        updated_at: 1000,
      },
    ];
    fakeSql.knowledge = [
      {
        id: 201,
        user_id: 10,
        server_id: 1,
        category: 'config',
        key: 'app_port',
        value: '3000',
        created_at: 1000,
        updated_at: 1000,
      },
    ];

    // 2. 批量调用：以 update_latest 更新工作日志，以 delete 删除废弃的知识项
    const resUpdate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memory/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          workLog: {
            mode: 'update_latest',
            title: '排查并修复端口冲突',
            summary: '已将冲突端口修改为 3001 并成功启动',
          },
          knowledge: [
            { action: 'delete', key: 'app_port' },
            { category: 'config', key: 'new_app_port', value: '3001' },
          ],
        }),
      })
    );
    expect(resUpdate.status).toBe(200);

    // 工作日志未增加，标题与内容已原子更新
    expect(fakeSql.workLogs).toHaveLength(1);
    expect(fakeSql.workLogs[0].title).toBe('排查并修复端口冲突');
    expect(fakeSql.workLogs[0].summary).toBe('已将冲突端口修改为 3001 并成功启动');

    // 旧知识项已删除，新知识项已添加
    expect(fakeSql.knowledge).toHaveLength(1);
    expect(fakeSql.knowledge[0].key).toBe('new_app_port');
    expect(fakeSql.knowledge[0].value).toBe('3001');
  });

  it('drops legacy tables on init and cleans up on server delete without 500 error', async () => {
    const droppedMemories = fakeSql.statements.some((s) =>
      s.query.includes('DROP TABLE IF EXISTS server_memories')
    );
    const droppedCheckpoints = fakeSql.statements.some((s) =>
      s.query.includes('DROP TABLE IF EXISTS server_task_checkpoints')
    );
    expect(droppedMemories).toBe(true);
    expect(droppedCheckpoints).toBe(true);

    const resDel = await userDb.fetch(
      new Request('http://internal/internal/servers/1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10 }),
      })
    );
    expect(resDel.status).toBe(200);
  });
});
