import { describe, expect, it } from 'vitest';
import { UserDBDO } from '../../src/worker/user-db';

class JumpSql {
  constructor(private readonly rows: Record<number, { user_id: number; jump_server_id: number | null }>) {}

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    if (query.includes('PRAGMA table_info(servers)')) {
      return {
        toArray: () => ['region', 'inferred_hint', 'tags', 'os', 'jump_server_id'].map((name) => ({ name })),
      };
    }
    if (query === 'SELECT user_id, jump_server_id FROM servers WHERE id = ?') {
      const row = this.rows[Number(values[0])];
      return { toArray: () => row ? [row] : [] };
    }
    return { toArray: () => [] };
  }
}

function validate(
  rows: Record<number, { user_id: number; jump_server_id: number | null }>,
  targetId: number | null,
  jumpId: number | null,
): string | null {
  const database = new UserDBDO(
    { storage: { sql: new JumpSql(rows) } } as unknown as DurableObjectState,
    {} as never,
  );
  return (database as unknown as {
    validateJumpChain: (userId: number, target: number | null, jump: number | null) => string | null;
  }).validateJumpChain(7, targetId, jumpId);
}

describe('UserDB jump chain validation', () => {
  it('接受最多三级且同属当前用户的跳板链', () => {
    expect(validate({
      1: { user_id: 7, jump_server_id: 2 },
      2: { user_id: 7, jump_server_id: 3 },
      3: { user_id: 7, jump_server_id: null },
    }, 9, 1)).toBeNull();
  });

  it('拒绝自引用和间接循环', () => {
    expect(validate({ 1: { user_id: 7, jump_server_id: null } }, 1, 1)).toContain('循环');
    expect(validate({
      1: { user_id: 7, jump_server_id: 2 },
      2: { user_id: 7, jump_server_id: 9 },
    }, 9, 1)).toContain('循环');
  });

  it('拒绝超深链路和跨用户引用', () => {
    expect(validate({
      1: { user_id: 7, jump_server_id: 2 },
      2: { user_id: 7, jump_server_id: 3 },
      3: { user_id: 7, jump_server_id: 4 },
      4: { user_id: 7, jump_server_id: null },
    }, 9, 1)).toContain('最多允许 3 级');
    expect(validate({ 1: { user_id: 8, jump_server_id: null } }, 9, 1)).toContain('其他用户');
  });
});

describe('UserDB jump connection resolution', () => {
  it('生成从公网入口到最终目标的不可变连接链，并采用入口区域', async () => {
    const servers = new Map<number, Record<string, unknown>>([
      [1, { id: 1, user_id: 7, name: 'C', host: 'c.example.com', port: 22, username: 'c', credential: 'cred-c', auth_method: 'password', region: 'weur', inferred_hint: null, os: null, jump_server_id: null }],
      [2, { id: 2, user_id: 7, name: 'A', host: '10.0.0.2', port: 22, username: 'a', credential: 'cred-a', auth_method: 'password', region: null, inferred_hint: null, os: null, jump_server_id: 1 }],
      [3, { id: 3, user_id: 7, name: 'B', host: '10.0.0.3', port: 22, username: 'b', credential: 'cred-b', auth_method: 'publickey', region: 'apac', inferred_hint: null, os: 'linux', jump_server_id: 2 }],
    ]);
    const sql = {
      exec(query: string, ...values: unknown[]) {
        if (query.includes('PRAGMA table_info(servers)')) {
          return { toArray: () => ['region', 'inferred_hint', 'tags', 'os', 'jump_server_id'].map((name) => ({ name })) };
        }
        if (query === 'SELECT * FROM servers WHERE id = ?') {
          const row = servers.get(Number(values[0]));
          return { toArray: () => row ? [row] : [] };
        }
        if (query.includes('SELECT fingerprint FROM known_hosts')) {
          return { toArray: () => [{ fingerprint: `fp:${String(values[1])}` }] };
        }
        if (query.includes('SELECT github_id FROM users')) {
          return { toArray: () => [{ github_id: 99 }] };
        }
        return { toArray: () => [] };
      },
    };
    const database = new UserDBDO(
      { storage: { sql } } as unknown as DurableObjectState,
      {} as never,
    );
    (database as unknown as { decryptCredential: (value: string) => Promise<string> }).decryptCredential = async (value) => value;

    const connect = await database.fetch(new Request('http://internal/internal/servers/3/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 7 }),
    }));
    expect(connect.status).toBe(200);
    const { token } = await connect.json() as { token: string };
    const consumed = await database.fetch(new Request('http://internal/internal/connect-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }));
    const config = await consumed.json() as {
      host: string;
      privateKey: string;
      locationHint: string;
      knownHostIdentity: string;
      jumpHosts: Array<{ name: string; knownHostIdentity: string }>;
    };

    expect(config.host).toBe('10.0.0.3');
    expect(config.privateKey).toBe('cred-b');
    expect(config.locationHint).toBe('weur');
    expect(config.jumpHosts.map((hop) => hop.name)).toEqual(['C', 'A']);
    expect(config.jumpHosts[0].knownHostIdentity).toBe('c.example.com');
    expect(config.jumpHosts[1].knownHostIdentity).toContain('jump:1@c.example.com:22|10.0.0.2');
    expect(config.knownHostIdentity).toContain('1@c.example.com:22>2@10.0.0.2:22|10.0.0.3');
  });
});
