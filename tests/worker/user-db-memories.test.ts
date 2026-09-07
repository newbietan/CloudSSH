import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));

vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import type { Env } from '../../src/types';
import { UserDBDO } from '../../src/worker/user-db';

interface MemoryRowRecord {
  id: number;
  user_id: number;
  server_id: number;
  category: string;
  fact_key: string;
  fact_value: string;
  source: string;
  created_at: number;
  updated_at: number;
}

class FakeSql {
  memories: MemoryRowRecord[] = [];
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

    if (q.includes('FROM server_memories WHERE server_id = ? AND user_id = ? AND fact_key = ?')) {
      const [serverId, userId, factKey] = values as [number, number, string];
      const row = this.memories.filter(
        (m) => m.server_id === serverId && m.user_id === userId && m.fact_key === factKey
      );
      return { toArray: () => row as unknown[] };
    }

    if (q.includes('FROM server_memories WHERE server_id = ? AND user_id = ?')) {
      const [serverId, userId] = values as [number, number];
      const rows = this.memories
        .filter((m) => m.server_id === serverId && m.user_id === userId)
        .sort((a, b) => {
          if (a.source === 'manual' && b.source !== 'manual') return -1;
          if (a.source !== 'manual' && b.source === 'manual') return 1;
          return b.updated_at - a.updated_at;
        });
      return { toArray: () => rows as unknown[] };
    }

    if (q.includes('COUNT(*) as count FROM server_memories')) {
      const [serverId, userId, factKey] = values as [number, number, string];
      const count = this.memories.filter(
        (m) => m.server_id === serverId && m.user_id === userId && m.fact_key !== factKey
      ).length;
      return { toArray: () => [{ count }] as unknown[] };
    }

    if (q.includes('SELECT user_id FROM server_memories WHERE id = ? AND server_id = ?')) {
      const [id, serverId] = values as [number, number];
      const found = this.memories.filter((m) => m.id === id && m.server_id === serverId);
      return { toArray: () => found as unknown[] };
    }

    if (q.startsWith('INSERT INTO server_memories')) {
      const [userId, serverId, category, factKey, factValue, source, createdAt, updatedAt] =
        values as [number, number, string, string, string, string, number, number];

      const existingIndex = this.memories.findIndex(
        (m) => m.user_id === userId && m.server_id === serverId && m.fact_key === factKey
      );

      if (existingIndex >= 0) {
        const existing = this.memories[existingIndex];
        // If manual and new is auto -> don't overwrite value
        if (existing.source === 'manual' && source === 'auto') {
          // keep existing
        } else {
          this.memories[existingIndex] = {
            ...existing,
            category,
            fact_value: factValue,
            source,
            updated_at: updatedAt,
          };
        }
      } else {
        const row: MemoryRowRecord = {
          id: this.nextId++,
          user_id: userId,
          server_id: serverId,
          category,
          fact_key: factKey,
          fact_value: factValue,
          source,
          created_at: createdAt,
          updated_at: updatedAt,
        };
        this.memories.push(row);
      }
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_memories WHERE id = ? AND server_id = ?')) {
      const [id, serverId, userId] = values as [number, number, number];
      this.memories = this.memories.filter(
        (m) => !(m.id === id && m.server_id === serverId && m.user_id === userId)
      );
      return { toArray: () => [] };
    }

    if (q.startsWith('DELETE FROM server_memories WHERE server_id = ?')) {
      const serverId = values[0];
      this.memories = this.memories.filter((m) => m.server_id !== serverId);
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }
}

describe('UserDBDO server memories', () => {
  let fakeSql: FakeSql;
  let userDb: UserDBDO;

  beforeEach(() => {
    fakeSql = new FakeSql();
    const ctx = {
      storage: {
        sql: fakeSql,
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as DurableObjectState;
    userDb = new UserDBDO(ctx, {} as Env);
  });

  it('lists server memories with ownership enforcement', async () => {
    // Other user's server -> 403
    const resForbidden = await userDb.fetch(
      new Request('http://internal/internal/servers/2/memories?user_id=10')
    );
    expect(resForbidden.status).toBe(403);

    // Non-existent server -> 404
    const resNotFound = await userDb.fetch(
      new Request('http://internal/internal/servers/999/memories?user_id=10')
    );
    expect(resNotFound.status).toBe(404);

    // Owned server -> 200
    const res = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories?user_id=10')
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it('saves and updates a memory fact with validation', async () => {
    // Missing fields -> 400
    const resEmpty = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10, fact_key: '', fact_value: '' }),
      })
    );
    expect(resEmpty.status).toBe(400);

    // Sensitive data -> 400
    const resSensitive = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          fact_key: 'root_password',
          fact_value: 'password=123456',
        }),
      })
    );
    expect(resSensitive.status).toBe(400);
    const sensitiveErr = (await resSensitive.json()) as { error: string };
    expect(sensitiveErr.error).toContain('敏感凭据');

    // Valid memory -> 201
    const resCreate = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          category: 'path',
          fact_key: 'nginx_conf',
          fact_value: '/etc/nginx/nginx.conf',
          source: 'manual',
        }),
      })
    );
    expect(resCreate.status).toBe(201);
    const created = (await resCreate.json()) as { fact_key: string; fact_value: string };
    expect(created.fact_key).toBe('nginx_conf');
    expect(created.fact_value).toBe('/etc/nginx/nginx.conf');
  });

  it('batch saves memories and prevents auto overwriting manual facts', async () => {
    // Manually set a memory first
    await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          category: 'path',
          fact_key: 'web_root',
          fact_value: '/custom/web/root',
          source: 'manual',
        }),
      })
    );

    // Batch distillation attempts to save facts, one of which has same key as manual
    const resBatch = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          memories: [
            { category: 'path', fact_key: 'web_root', fact_value: '/var/www', source: 'auto' },
            { category: 'service', fact_key: 'docker_ver', fact_value: 'Docker 26', source: 'auto' },
          ],
        }),
      })
    );
    expect(resBatch.status).toBe(200);

    // Check that web_root retained the manual value
    const resList = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories?user_id=10')
    );
    const list = (await resList.json()) as MemoryRowRecord[];
    expect(list).toHaveLength(2);

    const webRoot = list.find((m: MemoryRowRecord) => m.fact_key === 'web_root');
    expect(webRoot?.fact_value).toBe('/custom/web/root');
    expect(webRoot?.source).toBe('manual');

    const docker = list.find((m: MemoryRowRecord) => m.fact_key === 'docker_ver');
    expect(docker?.fact_value).toBe('Docker 26');
  });

  it('deletes a memory item with ownership check', async () => {
    // Create memory
    const res = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          category: 'env',
          fact_key: 'app_env',
          fact_value: 'production',
        }),
      })
    );
    const created = (await res.json()) as { id: number };

    // Delete by unauthorized user -> 403
    const resUnauth = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/memories/${created.id}?user_id=99`, {
        method: 'DELETE',
      })
    );
    expect(resUnauth.status).toBe(403);

    // Delete by owner -> 200
    const resDel = await userDb.fetch(
      new Request(`http://internal/internal/servers/1/memories/${created.id}?user_id=10`, {
        method: 'DELETE',
      })
    );
    expect(resDel.status).toBe(200);

    // Verify deletion
    const resList = await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories?user_id=10')
    );
    const list = (await resList.json()) as MemoryRowRecord[];
    expect(list).toHaveLength(0);
  });

  it('clears memories when server host or port changes', async () => {
    // Add a memory
    await userDb.fetch(
      new Request('http://internal/internal/servers/1/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          category: 'path',
          fact_key: 'web_root',
          fact_value: '/var/www',
        }),
      })
    );
    expect(fakeSql.memories).toHaveLength(1);

    // Update server host
    await userDb.fetch(
      new Request('http://internal/internal/servers/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 10,
          host: '10.0.0.99',
        }),
      })
    );

    // Memories should be cleared
    expect(fakeSql.memories).toHaveLength(0);
  });
});
