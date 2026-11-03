import { describe, expect, it, vi } from 'vitest';
import type { Env, SSHConnectionConfig } from '../../src/types';
import { getAccessUserRouteKey } from '../../src/worker/auth';
import { UserDBDO } from '../../src/worker/user-db';

class FakeSql {
  statements: Array<{ query: string; values: unknown[] }> = [];
  storedServer: Record<string, unknown> | null = null;
  referencedAsJump = false;
  throwOnInsert: string | null = null;
  userGithubId = 12345;
  encryptionSecret = 'test-encryption-secret-1234567890';
  accessUser: { id: number; github_id: number; username: string; avatar_url: null } | null = null;
  claimedShare: Record<string, unknown> | null = null;

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });

    if (query.includes('PRAGMA table_info(servers)')) {
      return {
        toArray: () => [
          { name: 'region' },
          { name: 'inferred_hint' },
          { name: 'tags' },
          { name: 'os' },
          { name: 'jump_server_id' },
          { name: 'transport_type' },
          { name: 'cf_tunnel_host' },
          { name: 'cf_access_client_id' },
          { name: 'cf_access_client_secret' },
          { name: 'cf_ssh_ca_team' },
          { name: 'last_connected_at' },
        ],
      };
    }
    if (query.includes('PRAGMA table_info(ssh_shares)')) {
      return { toArray: () => [] };
    }
    if (query.includes('PRAGMA table_info(command_snippets)')) {
      return { toArray: () => [] };
    }
    if (query.includes("SELECT value FROM system_config WHERE key = 'encryption_secret'")) {
      return { toArray: () => [{ value: this.encryptionSecret }] };
    }
    if (query.includes('SELECT github_id FROM users WHERE id = ?')) {
      return { toArray: () => [{ github_id: this.userGithubId }] };
    }
    if (query.includes('SELECT username FROM users WHERE id = ?')) {
      return { toArray: () => this.accessUser ? [{ username: this.accessUser.username }] : [] };
    }
    if (query.includes('FROM ssh_shares WHERE id = ?')) {
      return { toArray: () => this.claimedShare ? [this.claimedShare] : [] };
    }
    if (query.includes('FROM users WHERE github_id = ?')) {
      return { toArray: () => (this.accessUser ? [this.accessUser] : []) };
    }
    if (query.startsWith('INSERT INTO users')) {
      this.accessUser = {
        id: 1,
        github_id: values[0] as number,
        username: String(values[1]),
        avatar_url: null,
      };
      return { toArray: () => [] };
    }
    if (query.startsWith('UPDATE users SET username')) {
      if (this.accessUser) this.accessUser.username = String(values[0]);
      return { toArray: () => [] };
    }
    if (query.includes('SELECT fingerprint FROM known_hosts WHERE')) {
      return { toArray: () => [{ fingerprint: 'SHA256:trustedfingerprint' }] };
    }
    if (query.startsWith('INSERT INTO servers')) {
      if (this.throwOnInsert) throw new Error(this.throwOnInsert);
      this.storedServer = {
        id: 1,
        user_id: values[0],
        name: values[1],
        host: values[2],
        port: values[3],
        username: values[4],
        credential: values[5],
        auth_method: values[6],
        region: values[7],
        inferred_hint: values[8],
        tags: values[9],
        jump_server_id: values[10],
        transport_type: values[11],
        cf_tunnel_host: values[12],
        cf_access_client_id: values[13],
        cf_access_client_secret: values[14],
        cf_ssh_ca_team: values[15],
        created_at: '2026-05-18T00:00:00.000Z',
        updated_at: '2026-05-18T00:00:00.000Z',
      };
      return { toArray: () => [] };
    }
    if (query.includes('SELECT id FROM servers WHERE jump_server_id = ?')) {
      return { toArray: () => (this.referencedAsJump ? [{ id: 99 }] : []) };
    }
    if (query.includes('FROM servers WHERE user_id = ? ORDER BY id DESC LIMIT 1')) {
      return { toArray: () => (this.storedServer ? [this.storedServer] : []) };
    }
    if (query.includes('FROM servers WHERE id = ?')) {
      return { toArray: () => (this.storedServer ? [this.storedServer] : []) };
    }
    return { toArray: () => [] };
  }
}

function createTestDO() {
  const sql = new FakeSql();
  const mockState = {
    storage: {
      sql,
    },
  } as any;
  const mockEnv = {
    DEBUG_MODE: 'false',
  } as unknown as Env;
  const db = new UserDBDO(mockState, mockEnv);
  return { db, sql };
}

describe('UserDBDO - Cloudflare SSH CA integration', () => {
  it('保存时 SQL 异常返回 JSON，而不是让 Durable Object 请求拒绝', async () => {
    const { db, sql } = createTestDO();
    sql.throwOnInsert = 'no such column: cf_ssh_ca_team';

    const resp = await db.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 1,
          name: 'My CA Server',
          host: 'ca-node.example.com',
          port: 22,
          username: 'root',
          auth_method: 'publickey',
          cf_ssh_ca_team: 'my-team',
        }),
      })
    );

    expect(resp.status).toBe(500);
    const data = (await resp.json()) as { error?: string };
    expect(data.error).toBe('保存服务器失败');
    expect(JSON.stringify(data)).not.toContain('cf_ssh_ca_team');
  });

  it('saves server with cf_ssh_ca_team and permits empty credential', async () => {
    const { db } = createTestDO();

    const req = new Request('http://internal/internal/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 1,
        name: 'My CA Server',
        host: 'ca-node.example.com',
        port: 22,
        username: 'root',
        auth_method: 'publickey',
        credential: '',
        cf_ssh_ca_team: 'my-team',
      }),
    });

    const resp = await db.fetch(req);
    expect(resp.status).toBe(201);
    const data = (await resp.json()) as any;
    expect(data.cf_ssh_ca_team).toBe('my-team');
    expect(data.auth_method).toBe('publickey');
  });

  it('rejects a second Access email that lands in the same database', async () => {
    const { db, sql } = createTestDO();
    const first = await db.fetch(
      new Request('http://internal/internal/access-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com' }),
      })
    );
    expect(first.status).toBe(200);
    const second = await db.fetch(
      new Request('http://internal/internal/access-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bob@example.com' }),
      })
    );
    expect(second.status).toBe(403);
    expect(sql.accessUser?.username).toBe('alice@example.com');
  });

  it('issues an email-scoped connect token for an Access user', async () => {
    const { db, sql } = createTestDO();
    sql.userGithubId = -2;
    sql.accessUser = { id: 1, github_id: -2, username: 'user@example.com', avatar_url: null };
    sql.storedServer = {
      id: 10,
      user_id: 1,
      name: 'CA Target',
      host: 'node.example.com',
      port: 22,
      username: 'root',
      credential: '',
      auth_method: 'publickey',
      cf_ssh_ca_team: 'my-team',
      region: null,
      inferred_hint: null,
      jump_server_id: null,
      transport_type: 'direct',
    };
    const routeKey = await getAccessUserRouteKey('user@example.com');
    const resp = await db.fetch(
      new Request('http://internal/internal/servers/10/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 1, routeKey }),
      })
    );
    expect(resp.status).toBe(200);
    const { token } = (await resp.json()) as { token: string };
    expect(token.startsWith(`${routeKey}:`)).toBe(true);
  });

  it('Access-owned ordinary shares derive the owner route without a browser routeKey', async () => {
    const { db, sql } = createTestDO();
    sql.userGithubId = -2;
    sql.accessUser = { id: 1, github_id: -2, username: 'owner@example.com', avatar_url: null };
    sql.storedServer = { id: 10, user_id: 1, name: 'Shared', host: 'node.example.com', port: 22,
      username: 'developer', auth_method: 'none', credential: '', jump_server_id: null };
    sql.claimedShare = { user_id: 1, server_id: 10, share_ref: 'share-ref', status: 'claimed' };
    const res = await db.fetch(new Request('http://internal/internal/servers/10/share-config', {
      method: 'POST', body: JSON.stringify({ user_id: 1, share_id: 'share-id', share_ref: 'share-ref',
        session_expires_at: Date.now() + 60_000 }),
    }));
    expect(res.status).toBe(200);
    const config = await res.json() as SSHConnectionConfig;
    expect(config.userDbRouteKey).toBe(await getAccessUserRouteKey('owner@example.com'));
    expect(config.githubId).toBe('-2');
    expect(config.sessionPolicy?.allowAgent).toBe(false);
    expect(config.sessionPolicy?.shareRef).toBe('share-ref');
    const denied = await db.fetch(new Request('http://internal/internal/servers/10/connect', {
      method: 'POST', body: JSON.stringify({ user_id: 1, routeKey: await getAccessUserRouteKey('other@example.com') }),
    }));
    expect(denied.status).toBe(403);
  });

  it('does not expose unexpected database failures', async () => {
    const { db, sql } = createTestDO();
    vi.spyOn(sql, 'exec').mockImplementationOnce(() => { throw new Error('secret-schema-token'); });
    const res = await db.fetch(new Request('http://internal/internal/servers?user_id=1'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: '服务器内部错误' });
  });

  it('uses ephemeralCredential for connect token when server has cf_ssh_ca_team', async () => {
    const { db, sql } = createTestDO();
    sql.storedServer = {
      id: 10,
      user_id: 1,
      name: 'CA Target',
      host: 'node.example.com',
      port: 22,
      username: 'root',
      credential: '',
      auth_method: 'publickey',
      cf_ssh_ca_team: 'my-team',
      region: null,
      inferred_hint: null,
      jump_server_id: null,
      transport_type: 'direct',
    };

    const ephemeral = `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINX290U=\n-----END PRIVATE KEY-----\necdsa-sha2-nistp256-cert-v01@openssh.com AAAAHmockcert root@company`;

    const req = new Request('http://internal/internal/servers/10/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 1,
        ephemeralCredential: ephemeral,
      }),
    });

    const resp = await db.fetch(req);
    expect(resp.status).toBe(200);
    const { token } = (await resp.json()) as { token: string };
    expect(token).toBeDefined();

    // 消费 token 并验证解出的 config 包含 ephemeral 中的私钥和证书
    const consumeReq = new Request('http://internal/internal/connect-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const consumeResp = await db.fetch(consumeReq);
    expect(consumeResp.status).toBe(200);
    const config = (await consumeResp.json()) as any;
    expect(config.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(config.certificate).toContain('ecdsa-sha2-nistp256-cert-v01@openssh.com');
  });

  it('ignores ephemeralCredential when server does not have cf_ssh_ca_team', async () => {
    const { db, sql } = createTestDO();
    const encPass = await (db as any).encryptCredential('my-secret-password', 1);

    // 普通静态服务器
    sql.storedServer = {
      id: 20,
      user_id: 1,
      name: 'Normal Target',
      host: 'normal.example.com',
      port: 22,
      username: 'admin',
      credential: encPass,
      auth_method: 'password',
      cf_ssh_ca_team: null,
      region: null,
      inferred_hint: null,
      jump_server_id: null,
      transport_type: 'direct',
    };

    const req = new Request('http://internal/internal/servers/20/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 1,
        ephemeralCredential: 'attacker-injected-credential',
      }),
    });

    const resp = await db.fetch(req);
    expect(resp.status).toBe(200);
    const { token } = (await resp.json()) as { token: string };

    const consumeReq = new Request('http://internal/internal/connect-token/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const consumeResp = await db.fetch(consumeReq);
    const config = (await consumeResp.json()) as any;
    // 注入的凭据被忽略，仍使用数据库中解出的正确密码
    expect(config.password).toBe('my-secret-password');
    expect(config.privateKey).toBe('');
    expect(config.certificate).toBeUndefined();
  });

  it('rejects creating one-time share for cf_ssh_ca_team server', async () => {
    const { db, sql } = createTestDO();
    sql.storedServer = {
      id: 30,
      user_id: 1,
      name: 'CA Target',
      host: 'node.example.com',
      port: 22,
      username: 'root',
      credential: '',
      auth_method: 'publickey',
      cf_ssh_ca_team: 'my-team',
      region: null,
      inferred_hint: null,
      jump_server_id: null,
      transport_type: 'direct',
    };

    const req = new Request('http://internal/internal/servers/30/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 1,
        share_id: 'test-share-123',
        share_ref: 'test-ref-123',
        expires_at: Date.now() + 600_000,
        max_session_seconds: 600,
      }),
    });

    const resp = await db.fetch(req);
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as any;
    expect(data.error).toContain('Cloudflare SSH CA 认证的服务器不支持创建一次性分享');
  });

  it('rejects using cf_ssh_ca_team server as jump host', async () => {
    const { db, sql } = createTestDO();
    sql.storedServer = {
      id: 40,
      user_id: 1,
      name: 'CA Jump Hop',
      host: 'ca-jump.example.com',
      port: 22,
      username: 'root',
      credential: '',
      auth_method: 'publickey',
      cf_ssh_ca_team: 'my-team',
      region: null,
      inferred_hint: null,
      jump_server_id: null,
      transport_type: 'direct',
    };

    const req = new Request('http://internal/internal/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 1,
        name: 'Target Behind CA Jump',
        host: 'internal.example.com',
        port: 22,
        username: 'root',
        auth_method: 'password',
        credential: 'pwd',
        jump_server_id: 40,
      }),
    });

    const resp = await db.fetch(req);
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as any;
    expect(data.error).toContain('Cloudflare SSH CA 认证的服务器不支持作为跳板机');
  });

  it('rejects converting a referenced jump host into Cloudflare SSH CA', async () => {
    const { db, sql } = createTestDO();
    sql.referencedAsJump = true;
    sql.storedServer = {
      id: 40,
      user_id: 1,
      name: 'Bastion',
      host: 'bastion.example.com',
      port: 22,
      username: 'root',
      credential: 'encrypted',
      auth_method: 'publickey',
      cf_ssh_ca_team: null,
      region: null,
      inferred_hint: null,
      jump_server_id: null,
      transport_type: 'direct',
    };

    const resp = await db.fetch(
      new Request('http://internal/internal/servers/40', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 1,
          cf_ssh_ca_team: 'my-team',
        }),
      })
    );
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error?: string };
    expect(data.error).toContain('不支持作为跳板机');
  });
});
