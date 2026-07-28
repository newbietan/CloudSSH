import { describe, expect, it } from 'vitest';
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
});
