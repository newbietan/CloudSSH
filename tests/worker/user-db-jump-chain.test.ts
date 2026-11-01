import { describe, expect, it, vi } from 'vitest';
import type { SSHConnectionConfig } from '../../src/types';
import { UserDBDO } from '../../src/worker/user-db';

type JumpFixture = {
  user_id: number;
  jump_server_id: number | null;
  cf_ssh_ca_team?: string | null;
};

class JumpSql {
  constructor(private readonly rows: Record<number, JumpFixture>) {}

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    if (query.includes('PRAGMA table_info(servers)')) {
      return {
        toArray: () =>
          ['region', 'inferred_hint', 'tags', 'os', 'jump_server_id'].map((name) => ({ name })),
      };
    }
    if (query === 'SELECT user_id, jump_server_id, cf_ssh_ca_team FROM servers WHERE id = ?') {
      const row = this.rows[Number(values[0])];
      return {
        toArray: () => (row ? [{ ...row, cf_ssh_ca_team: row.cf_ssh_ca_team ?? null }] : []),
      };
    }
    return { toArray: () => [] };
  }
}

function validate(
  rows: Record<number, JumpFixture>,
  targetId: number | null,
  jumpId: number | null
): string | null {
  const database = new UserDBDO(
    { storage: { sql: new JumpSql(rows) } } as unknown as DurableObjectState,
    {} as never
  );
  return (
    database as unknown as {
      validateJumpChain: (
        userId: number,
        target: number | null,
        jump: number | null
      ) => string | null;
    }
  ).validateJumpChain(7, targetId, jumpId);
}

describe('UserDB jump chain validation', () => {
  it('接受最多三级且同属当前用户的跳板链', () => {
    expect(
      validate(
        {
          1: { user_id: 7, jump_server_id: 2 },
          2: { user_id: 7, jump_server_id: 3 },
          3: { user_id: 7, jump_server_id: null },
        },
        9,
        1
      )
    ).toBeNull();
  });

  it('拒绝自引用和间接循环', () => {
    expect(validate({ 1: { user_id: 7, jump_server_id: null } }, 1, 1)).toContain('循环');
    expect(
      validate(
        {
          1: { user_id: 7, jump_server_id: 2 },
          2: { user_id: 7, jump_server_id: 9 },
        },
        9,
        1
      )
    ).toContain('循环');
  });

  it('拒绝超深链路和跨用户引用', () => {
    expect(
      validate(
        {
          1: { user_id: 7, jump_server_id: 2 },
          2: { user_id: 7, jump_server_id: 3 },
          3: { user_id: 7, jump_server_id: 4 },
          4: { user_id: 7, jump_server_id: null },
        },
        9,
        1
      )
    ).toContain('最多允许 3 级');
    expect(validate({ 1: { user_id: 8, jump_server_id: null } }, 9, 1)).toContain('其他用户');
  });

  it('拒绝把 Cloudflare SSH CA 服务器放进跳板链的任一跳', () => {
    expect(
      validate({ 1: { user_id: 7, jump_server_id: null, cf_ssh_ca_team: 'team' } }, 9, 1)
    ).toContain('不支持作为跳板机');
    expect(
      validate(
        {
          1: { user_id: 7, jump_server_id: 2, cf_ssh_ca_team: null },
          2: { user_id: 7, jump_server_id: null, cf_ssh_ca_team: 'team' },
        },
        9,
        1
      )
    ).toContain('不支持作为跳板机');
  });
});

describe('UserDB jump connection resolution', () => {
  it.each([false, true])('生成不可变连接链，保留 none 目标/跳板认证及分享策略（none=%s）', async (useNone) => {
    const servers = new Map<number, Record<string, unknown>>([
      [
        1,
        {
          id: 1,
          user_id: 7,
          name: 'C',
          host: 'c.example.com',
          port: 22,
          username: 'c',
          credential: 'cred-c',
          auth_method: useNone ? 'none' : 'password',
          region: 'weur',
          inferred_hint: null,
          os: null,
          jump_server_id: null,
        },
      ],
      [
        2,
        {
          id: 2,
          user_id: 7,
          name: 'A',
          host: '10.0.0.2',
          port: 22,
          username: 'a',
          credential: useNone ? '' : 'cred-a',
          auth_method: 'password',
          region: null,
          inferred_hint: null,
          os: null,
          jump_server_id: 1,
        },
      ],
      [
        3,
        {
          id: 3,
          user_id: 7,
          name: 'B',
          host: '10.0.0.3',
          port: 22,
          username: 'b',
          credential: 'cred-b',
          auth_method: useNone ? 'none' : 'publickey',
          region: 'apac',
          inferred_hint: null,
          os: 'linux',
          jump_server_id: 2,
        },
      ],
    ]);
    const sql = {
      exec(query: string, ...values: unknown[]) {
        if (query.includes('PRAGMA table_info(servers)')) {
          return {
            toArray: () =>
              ['region', 'inferred_hint', 'tags', 'os', 'jump_server_id'].map((name) => ({ name })),
          };
        }
        if (query === 'SELECT * FROM servers WHERE id = ?') {
          const row = servers.get(Number(values[0]));
          return { toArray: () => (row ? [row] : []) };
        }
        if (query.includes('SELECT fingerprint FROM known_hosts')) {
          return { toArray: () => [{ fingerprint: `fp:${String(values[1])}` }] };
        }
        if (query.includes('SELECT github_id FROM users')) {
          return { toArray: () => [{ github_id: 99 }] };
        }
        if (query.includes('FROM ssh_shares WHERE id = ?')) {
          return { toArray: () => [{ user_id: 7, server_id: 3, share_ref: 'share-ref', status: 'claimed' }] };
        }
        return { toArray: () => [] };
      },
    };
    const database = new UserDBDO(
      { storage: { sql } } as unknown as DurableObjectState,
      {} as never
    );
    const decrypt = vi.spyOn(database as any, 'decryptCredential')
      .mockImplementation(async (value: unknown) => value);

    const connect = await database.fetch(
      new Request('http://internal/internal/servers/3/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 7 }),
      })
    );
    expect(connect.status).toBe(200);
    const { token } = (await connect.json()) as { token: string };
    const consumed = await database.fetch(
      new Request('http://internal/internal/connect-token/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    );
    const config = (await consumed.json()) as SSHConnectionConfig & { jumpHosts: NonNullable<SSHConnectionConfig['jumpHosts']> };

    expect(config.host).toBe('10.0.0.3');
    expect(config.authMethod).toBe(useNone ? 'none' : 'publickey');
    expect(config.privateKey).toBe(useNone ? '' : 'cred-b');
    expect(config.password).toBe('');
    expect(config.jumpHosts[0]).toMatchObject({ authMethod: useNone ? 'none' : 'password', password: useNone ? '' : 'cred-c', privateKey: '' });
    expect(config.jumpHosts[1]).toMatchObject({ authMethod: 'password', password: useNone ? '' : 'cred-a' });
    if (useNone) {
      expect(decrypt).not.toHaveBeenCalledWith('cred-b', 7);
      expect(decrypt).not.toHaveBeenCalledWith('cred-c', 7);
    }
    expect(config.locationHint).toBe('weur');
    expect(config.jumpHosts.map((hop) => hop.name)).toEqual(['C', 'A']);
    expect(config.jumpHosts[0].knownHostIdentity).toBe('c.example.com');
    expect(config.jumpHosts[1].knownHostIdentity).toContain('jump:1@c.example.com:22|10.0.0.2');
    expect(config.knownHostIdentity).toContain('1@c.example.com:22>2@10.0.0.2:22|10.0.0.3');

    const shared = await database.fetch(new Request('http://internal/internal/servers/3/share-config', {
      method: 'POST', body: JSON.stringify({ user_id: 7, share_id: 'share-id', share_ref: 'share-ref', session_expires_at: Date.now() + 60_000 }),
    }));
    expect(shared.status).toBe(200);
    await expect(shared.json()).resolves.toMatchObject({
      authMethod: useNone ? 'none' : 'publickey',
      jumpHosts: [expect.objectContaining({ authMethod: useNone ? 'none' : 'password' }), expect.objectContaining({ authMethod: 'password', password: useNone ? '' : 'cred-a' })],
      sessionPolicy: { source: 'share', allowAgent: false, allowSftp: true,
        allowMetadataMutation: false, allowHostKeyMutation: false, allowReconnect: false },
    });
  });
});
