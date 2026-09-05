import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));
vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import { UserDBDO } from '../../src/worker/user-db';

class FakeSql {
  snippets: Array<Record<string, unknown>> = [];
  private nextId = 1;
  statements: Array<{ query: string; values: unknown[] }> = [];

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });
    if (
      query.includes('CREATE TABLE') ||
      query.includes('CREATE INDEX') ||
      query.includes('PRAGMA table_info')
    ) {
      if (query.includes('PRAGMA table_info(servers)')) {
        return { toArray: () => [{ name: 'region' }, { name: 'inferred_hint' }] as unknown[] };
      }
      return { toArray: () => [] };
    }
    if (
      query.includes('SELECT') &&
      query.includes('FROM command_snippets WHERE user_id = ? ORDER BY id ASC')
    ) {
      const uid = values[0];
      return { toArray: () => this.snippets.filter((r) => r.user_id === uid) as unknown[] };
    }
    if (query.includes('COUNT(*) AS count FROM command_snippets')) {
      const uid = values[0];
      return {
        toArray: () =>
          [{ count: this.snippets.filter((r) => r.user_id === uid).length }] as unknown[],
      };
    }
    if (query.startsWith('INSERT INTO command_snippets')) {
      const row = {
        id: this.nextId++,
        user_id: values[0],
        name: values[1],
        command: values[2],
        category: values[3] ?? '',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };
      this.snippets.push(row);
      return { toArray: () => [] };
    }
    if (
      query.includes(
        'FROM command_snippets WHERE user_id = ? ORDER BY id DESC LIMIT 1'
      )
    ) {
      const uid = values[0];
      const rows = this.snippets
        .filter((r) => r.user_id === uid)
        .sort((a, b) => (b as { id: number }).id - (a as { id: number }).id);
      return { toArray: () => (rows.length ? [rows[0]] : []) as unknown[] };
    }
    if (query === 'SELECT id FROM command_snippets WHERE user_id = ? AND id = ?') {
      const [uid, id] = values;
      return {
        toArray: () =>
          this.snippets
            .filter((r) => r.user_id === uid && r.id === id)
            .map((r) => ({ id: r.id })) as unknown[],
      };
    }
    if (
      query.startsWith('SELECT') &&
      query.includes('FROM command_snippets WHERE user_id = ? AND id = ?') &&
      !query.includes('SELECT id FROM')
    ) {
      const [uid, id] = values;
      return {
        toArray: () => this.snippets.filter((r) => r.user_id === uid && r.id === id) as unknown[],
      };
    }
    if (query.startsWith('UPDATE command_snippets SET')) {
      const [name, command, category, uid, id] = values;
      this.snippets = this.snippets.map((r) =>
        r.user_id === uid && r.id === id ? { ...r, name, command, category } : r
      );
      return { toArray: () => [] };
    }
    if (query.startsWith('DELETE FROM command_snippets WHERE user_id = ? AND id = ?')) {
      const [uid, id] = values;
      this.snippets = this.snippets.filter((r) => !(r.user_id === uid && r.id === id));
      return { toArray: () => [] };
    }
    return { toArray: () => [] };
  }
}

function createUserDB(sql: FakeSql): UserDBDO {
  return new UserDBDO(
    { storage: { sql } } as unknown as DurableObjectState,
    { DEBUG_MODE: 'false' } as never
  );
}

function jsonRequest(url: string, init: RequestInit): Request {
  return new Request(url, init);
}

describe('UserDB 命令片段', () => {
  beforeEach(() => inferLocationHintMock.mockReset());

  it('建表语句包含 command_snippets', async () => {
    const sql = new FakeSql();
    createUserDB(sql);
    const hasTable = sql.statements.some((s) =>
      s.query.includes('CREATE TABLE IF NOT EXISTS command_snippets')
    );
    const hasIndex = sql.statements.some((s) => s.query.includes('idx_command_snippets_user'));
    const hasCategoryMigration = sql.statements.some((s) =>
      s.query.includes('ALTER TABLE command_snippets ADD COLUMN category')
    );
    expect(hasTable).toBe(true);
    expect(hasIndex).toBe(true);
    expect(hasCategoryMigration).toBe(true);
  });

  it('GET 按 user_id 隔离', async () => {
    const sql = new FakeSql();
    sql.snippets = [
      { id: 1, user_id: 7, name: 'a', command: 'echo a', created_at: '', updated_at: '' },
      { id: 2, user_id: 8, name: 'b', command: 'echo b', created_at: '', updated_at: '' },
    ];
    const db = createUserDB(sql);
    const res = await db.fetch(
      jsonRequest('http://internal/internal/snippets?user_id=7', { method: 'GET' })
    );
    const rows = (await res.json()) as Array<{ id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
  });

  it('POST 校验缺失与超长', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);
    let res = await db.fetch(
      jsonRequest('http://internal/internal/snippets', {
        method: 'POST',
        body: JSON.stringify({ user_id: 7, name: '', command: 'echo hi' }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('nameRequired');

    res = await db.fetch(
      jsonRequest('http://internal/internal/snippets', {
        method: 'POST',
        body: JSON.stringify({ user_id: 7, name: 'ok', command: '' }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(((await res.json()) as { error: string }).error).toBe('commandRequired');

    res = await db.fetch(
      jsonRequest('http://internal/internal/snippets', {
        method: 'POST',
        body: JSON.stringify({ user_id: 7, name: 'a'.repeat(51), command: 'echo hi' }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(((await res.json()) as { error: string }).error).toBe('nameTooLong');
  });

  it('POST 达到上限后拒绝', async () => {
    const sql = new FakeSql();
    for (let i = 0; i < 100; i++)
      sql.snippets.push({
        id: i + 1,
        user_id: 7,
        name: 'n' + i,
        command: 'echo ' + i,
        created_at: '',
        updated_at: '',
      });
    const db = createUserDB(sql);
    const res = await db.fetch(
      jsonRequest('http://internal/internal/snippets', {
        method: 'POST',
        body: JSON.stringify({ user_id: 7, name: 'new', command: 'echo new' }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('limitReached');
  });

  it('POST 支持保存 category 并在超长时拒绝', async () => {
    const sql = new FakeSql();
    const db = createUserDB(sql);
    let res = await db.fetch(
      jsonRequest('http://internal/internal/snippets', {
        method: 'POST',
        body: JSON.stringify({
          user_id: 7,
          name: '查看 Docker',
          command: 'docker ps',
          category: 'Docker/容器',
        }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { category: string };
    expect(created.category).toBe('Docker/容器');

    res = await db.fetch(
      jsonRequest('http://internal/internal/snippets', {
        method: 'POST',
        body: JSON.stringify({
          user_id: 7,
          name: '超长分类',
          command: 'echo 1',
          category: 'a'.repeat(31),
        }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('categoryTooLong');
  });

  it('PUT 仅允许更新属于当前用户的片段并支持更新分类', async () => {
    const sql = new FakeSql();
    sql.snippets = [
      {
        id: 1,
        user_id: 7,
        name: 'a',
        command: 'echo a',
        category: 'old',
        created_at: '',
        updated_at: '',
      },
    ];
    const db = createUserDB(sql);
    let res = await db.fetch(
      jsonRequest('http://internal/internal/snippets/1', {
        method: 'PUT',
        body: JSON.stringify({ user_id: 8, name: 'hacked', command: 'rm -rf /', category: 'hack' }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(404);

    res = await db.fetch(
      jsonRequest('http://internal/internal/snippets/1', {
        method: 'PUT',
        body: JSON.stringify({
          user_id: 7,
          name: 'updated',
          command: 'echo updated',
          category: 'newCategory',
        }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { name: string; category: string };
    expect(updated.name).toBe('updated');
    expect(updated.category).toBe('newCategory');
  });

  it('DELETE 按 user_id 隔离', async () => {
    const sql = new FakeSql();
    sql.snippets = [
      { id: 1, user_id: 7, name: 'a', command: 'echo a', created_at: '', updated_at: '' },
    ];
    const db = createUserDB(sql);
    const res = await db.fetch(
      jsonRequest('http://internal/internal/snippets/1', {
        method: 'DELETE',
        body: JSON.stringify({ user_id: 8 }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(200);
    expect(sql.snippets.length).toBe(1);
    const res2 = await db.fetch(
      jsonRequest('http://internal/internal/snippets/1', {
        method: 'DELETE',
        body: JSON.stringify({ user_id: 7 }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res2.status).toBe(200);
    expect(sql.snippets.length).toBe(0);
  });
});
