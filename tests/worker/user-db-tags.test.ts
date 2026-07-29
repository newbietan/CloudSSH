import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));

vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import { UserDBDO } from '../../src/worker/user-db';

class FakeSql {
  statements: Array<{ query: string; values: unknown[] }> = [];
  storedTags = '["production","apac"]';

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });

    if (query.includes('PRAGMA table_info(servers)')) {
      return {
        toArray: () => [
          { name: 'region' },
          { name: 'inferred_hint' },
        ],
      };
    }
    if (query.includes('SELECT user_id FROM servers WHERE id')) {
      return { toArray: () => [{ user_id: 7 }] };
    }
    if (query.startsWith('UPDATE servers SET')) {
      const tagsIndex = query.split(', ').findIndex((part) => part.includes('tags = ?'));
      if (tagsIndex >= 0) this.storedTags = String(values[tagsIndex]);
      return { toArray: () => [] };
    }
    if (query.includes('FROM servers WHERE user_id = ?')) {
      return { toArray: () => [this.serverRow()] };
    }
    if (query.includes('FROM servers WHERE id = ?')) {
      return { toArray: () => [this.serverRow()] };
    }
    return { toArray: () => [] };
  }

  private serverRow(): Record<string, unknown> {
    return {
      id: 1,
      user_id: 7,
      name: 'Production',
      host: 'prod.example.com',
      port: 22,
      username: 'deploy',
      auth_method: 'publickey',
      region: null,
      inferred_hint: 'apac',
      tags: this.storedTags,
      created_at: '',
      updated_at: '',
    };
  }
}

function createUserDB(sql: FakeSql): UserDBDO {
  return new UserDBDO(
    { storage: { sql } } as unknown as DurableObjectState,
    { DEBUG_MODE: 'false' } as never,
  );
}

describe('UserDB server tags', () => {
  beforeEach(() => {
    inferLocationHintMock.mockReset();
    inferLocationHintMock.mockResolvedValue({ hint: 'apac', debug: [] });
  });

  it('adds the tags column idempotently and returns parsed tag arrays', async () => {
    const sql = new FakeSql();
    const database = createUserDB(sql);

    expect(sql.statements.some(({ query }) =>
      query.includes("ALTER TABLE servers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'"),
    )).toBe(true);

    const response = await database.fetch(new Request('http://internal/internal/servers?user_id=7'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ tags: ['production', 'apac'] }),
    ]);
  });

  it('normalizes tags before updating SQLite', async () => {
    const sql = new FakeSql();
    const database = createUserDB(sql);

    const response = await database.fetch(new Request('http://internal/internal/servers/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 7,
        tags: [' Production ', 'production', 'database'],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ tags: ['Production', 'database'] }),
    );
    expect(sql.statements.some(({ query, values }) =>
      query.startsWith('UPDATE servers SET tags = ?') &&
      values[0] === '["Production","database"]',
    )).toBe(true);
  });

  it('切换认证方式时拒绝沿用旧认证方式的凭据', async () => {
    const sql = new FakeSql();
    const database = createUserDB(sql);

    const response = await database.fetch(new Request('http://internal/internal/servers/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 7,
        auth_method: 'password',
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: '切换认证方式时必须同时提供对应凭据',
    });
    expect(sql.statements.some(({ query }) => query.startsWith('UPDATE servers SET'))).toBe(false);
  });

  it('认证方式不变时允许保留原凭据', async () => {
    const sql = new FakeSql();
    const database = createUserDB(sql);

    const response = await database.fetch(new Request('http://internal/internal/servers/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 7,
        name: 'Production SSH',
        auth_method: 'publickey',
      }),
    }));

    expect(response.status).toBe(200);
    expect(sql.statements.some(({ query }) =>
      query.startsWith('UPDATE servers SET name = ?, auth_method = ?'),
    )).toBe(true);
  });

  it('手动指定区域时保存服务器不会查询 IPinfo', async () => {
    const sql = new FakeSql();
    const database = createUserDB(sql);

    const response = await database.fetch(new Request('http://internal/internal/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 7,
        name: 'Production',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        credential: 'secret',
        auth_method: 'password',
        region: 'weur',
      }),
    }));

    expect(response.status).toBe(201);
    expect(inferLocationHintMock).not.toHaveBeenCalled();
    expect(sql.statements.some(({ query, values }) =>
      query.startsWith('INSERT INTO servers') && values[7] === 'weur' && values[8] === null,
    )).toBe(true);
  });

  it('新增服务器时严格拒绝范围外或非整数端口', async () => {
    for (const port of [0, 65536, 22.5]) {
      const sql = new FakeSql();
      const database = createUserDB(sql);
      const response = await database.fetch(new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'Production',
          host: 'prod.example.com',
          port,
          username: 'deploy',
          credential: 'secret',
          auth_method: 'password',
        }),
      }));

      expect(response.status).toBe(400);
      expect(sql.statements.some(({ query }) => query.startsWith('INSERT INTO servers'))).toBe(false);
    }
    expect(inferLocationHintMock).not.toHaveBeenCalled();
  });

  it('主机和自动区域均未变化时编辑服务器不会重复查询 IPinfo', async () => {
    const sql = new FakeSql();
    const database = createUserDB(sql);

    const response = await database.fetch(new Request('http://internal/internal/servers/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 7,
        name: 'Production SSH',
        host: 'prod.example.com',
        region: '',
      }),
    }));

    expect(response.status).toBe(200);
    expect(inferLocationHintMock).not.toHaveBeenCalled();
  });
});
