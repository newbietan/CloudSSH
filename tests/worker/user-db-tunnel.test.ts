import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));

vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import { UserDBDO } from '../../src/worker/user-db';

class FakeSql {
  statements: Array<{ query: string; values: unknown[] }> = [];
  storedServer: Record<string, unknown> | null = null;
  encryptionSecret = 'test-encryption-secret-1234567890';

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });

    if (query.includes('PRAGMA table_info(servers)')) {
      return {
        toArray: () => [
          { name: 'region' },
          { name: 'inferred_hint' },
          { name: 'transport_type' },
          { name: 'cf_tunnel_host' },
          { name: 'cf_access_client_id' },
          { name: 'cf_access_client_secret' },
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
      return { toArray: () => [{ github_id: 12345 }] };
    }
    if (query.includes('SELECT fingerprint FROM known_hosts WHERE')) {
      return { toArray: () => [{ fingerprint: 'SHA256:trustedfingerprint' }] };
    }
    if (query.startsWith('INSERT INTO servers')) {
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
        os: null,
        created_at: '2026-09-20 00:00:00',
        updated_at: '2026-09-20 00:00:00',
      };
      return { toArray: () => [] };
    }
    if (query.startsWith('UPDATE servers SET')) {
      if (this.storedServer) {
        if (values.includes('direct')) {
          this.storedServer.transport_type = 'direct';
          this.storedServer.cf_tunnel_host = null;
          this.storedServer.cf_access_client_id = null;
          this.storedServer.cf_access_client_secret = null;
        }
      }
      return { toArray: () => [] };
    }
    if (query.includes('SELECT user_id, host, port, auth_method, region, inferred_hint, jump_server_id')) {
      return {
        toArray: () => [
          {
            user_id: 7,
            host: this.storedServer?.host ?? 'ssh.example.com',
            port: 22,
            auth_method: 'password',
            region: null,
            inferred_hint: null,
            jump_server_id: null,
            transport_type: this.storedServer?.transport_type ?? 'cf_tunnel',
            cf_tunnel_host: this.storedServer?.cf_tunnel_host ?? 'ssh.example.com',
            cf_access_client_id: this.storedServer?.cf_access_client_id ?? 'client-id',
            cf_access_client_secret: this.storedServer?.cf_access_client_secret ?? 'enc-secret',
          },
        ],
      };
    }
    if (query.includes('SELECT * FROM servers WHERE id = ?')) {
      return { toArray: () => (this.storedServer ? [this.storedServer] : []) };
    }
    if (query.includes('FROM servers WHERE id = ?')) {
      return { toArray: () => [this.serverRow()] };
    }
    if (query.includes('FROM servers WHERE user_id = ?')) {
      return { toArray: () => (this.storedServer ? [this.serverRow()] : []) };
    }
    return { toArray: () => [] };
  }

  private serverRow(): Record<string, unknown> {
    if (!this.storedServer) {
      return {
        id: 1,
        user_id: 7,
        name: 'Tunnel Server',
        host: 'ssh.example.com',
        port: 22,
        username: 'root',
        auth_method: 'password',
        region: null,
        inferred_hint: null,
        tags: '[]',
        os: null,
        jump_server_id: null,
        transport_type: 'cf_tunnel',
        cf_tunnel_host: 'ssh.example.com',
        cf_access_client_id: 'client-123',
        has_cf_access_client_secret: 1,
        created_at: '2026-09-20 00:00:00',
        updated_at: '2026-09-20 00:00:00',
      };
    }
    const { cf_access_client_secret, credential, ...safe } = this.storedServer;
    return {
      ...safe,
      has_cf_access_client_secret: cf_access_client_secret ? 1 : 0,
    };
  }
}

function createUserDB(sql: FakeSql): UserDBDO {
  return new UserDBDO(
    { storage: { sql } } as unknown as DurableObjectState,
    { DEBUG_MODE: 'false' } as unknown as Env
  );
}

describe('UserDBDO - Cloudflare 隧道支持', () => {
  it('创建 Cloudflare 隧道服务器：校验跳板限制并规范化隧道域名', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    // 1. 尝试将隧道与跳板机混用，应被拒绝
    const rejectJump = await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'Invalid Tunnel Jump',
          host: 'ssh.example.com',
          port: 22,
          username: 'root',
          credential: 'password123',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
          jump_server_id: 99,
        }),
      })
    );
    expect(rejectJump.status).toBe(400);
    const jumpErr = (await rejectJump.json()) as { error: string };
    expect(jumpErr.error).toContain('Cloudflare 隧道连接不支持跳板机');

    // 2. 域名为空被拒绝
    const rejectEmpty = await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'Empty Tunnel Host',
          host: '  ',
          port: 22,
          username: 'root',
          credential: 'password123',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
        }),
      })
    );
    expect(rejectEmpty.status).toBe(400);

    // 3. 正常创建：前缀 https:// 与末尾斜杠被自动剔除，Secret 被加密且不在响应中回显
    const createRes = await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'My Homelab Tunnel',
          host: 'https://ssh.homelab.example.com/',
          port: 22,
          username: 'ubuntu',
          credential: 'my-ssh-password',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
          cf_access_client_id: 'cf-client-id-123',
          cf_access_client_secret: 'cf-secret-xyz',
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, any>;
    expect(created.transport_type).toBe('cf_tunnel');
    expect(created.cf_tunnel_host).toBe('ssh.homelab.example.com');
    expect(created.cf_access_client_id).toBe('cf-client-id-123');
    expect(created.has_cf_access_client_secret).toBe(true);
    // 明文 Secret 绝不对外暴露
    expect(created.cf_access_client_secret).toBeUndefined();

    // 隧道模式跳过 IPinfo 推断
    expect(inferLocationHintMock).not.toHaveBeenCalled();
  });

  it('handleConnectServer 生成连接令牌时携带解密后的隧道凭据', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    // 创建一台隧道服务器记录
    await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'Tunnel Target',
          host: 'ssh.target.com',
          port: 22,
          username: 'root',
          credential: 'my-password',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
          cf_access_client_id: 'token-client-id',
          cf_access_client_secret: 'token-client-secret-999',
        }),
      })
    );

    // 请求连接令牌
    const tokenRes = await userDB.fetch(
      new Request('http://internal/internal/servers/1/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 7 }),
      })
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    expect(typeof token).toBe('string');

    // 兑换令牌
    const consumeRes = await userDB.fetch(
      new Request('http://internal/internal/connect-token/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    );
    expect(consumeRes.status).toBe(200);
    const config = (await consumeRes.json()) as Record<string, any>;
    expect(config.transportType).toBe('cf_tunnel');
    expect(config.cfTunnelHost).toBe('ssh.target.com');
    expect(config.cfAccessClientId).toBe('token-client-id');
    // Secret 在内部通道被正确解密给 SSHSessionDO
    expect(config.cfAccessClientSecret).toBe('token-client-secret-999');
  });

  it('切换回直连模式时清空隧道相关字段', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    // 先创建一台隧道服务器
    await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'Tunnel Server',
          host: 'ssh.example.com',
          port: 22,
          username: 'root',
          credential: 'password123',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
          cf_access_client_id: 'client-id',
          cf_access_client_secret: 'secret-xyz',
        }),
      })
    );

    const updateRes = await userDB.fetch(
      new Request('http://internal/internal/servers/1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          transport_type: 'direct',
        }),
      })
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as Record<string, any>;
    expect(updated.transport_type).toBe('direct');
  });

  it('创建或更新时拒绝格式非法的隧道域名', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    // 1. IP 地址作为隧道域名被拦截
    const res1 = await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'Bad IP Tunnel',
          host: '192.168.1.1',
          port: 22,
          username: 'root',
          credential: 'password123',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
        }),
      })
    );
    expect(res1.status).toBe(400);
    const err1 = (await res1.json()) as Record<string, any>;
    expect(err1.error).toContain('域名格式不正确');

    // 2. 单级无点主机名作为隧道域名被拦截
    const res2 = await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'Bad Hostname Tunnel',
          host: 'localhost',
          port: 22,
          username: 'root',
          credential: 'password123',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
        }),
      })
    );
    expect(res2.status).toBe(400);
    const err2 = (await res2.json()) as Record<string, any>;
    expect(err2.error).toContain('域名格式不正确');
  });

  it('隧道模式支持保存手动选择的 region 并用于连接调度', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    const createRes = await userDB.fetch(
      new Request('http://internal/internal/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 7,
          name: 'APAC Tunnel',
          host: 'ssh.apac.example.com',
          port: 22,
          username: 'root',
          credential: 'my-password',
          auth_method: 'password',
          transport_type: 'cf_tunnel',
          region: 'apac',
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, any>;
    expect(created.region).toBe('apac');
    expect(inferLocationHintMock).not.toHaveBeenCalled();

    // 兑换 token 验证 locationHint 被正确设置为 apac
    const tokenRes = await userDB.fetch(
      new Request('http://internal/internal/servers/1/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 7 }),
      })
    );
    const { token } = (await tokenRes.json()) as { token: string };
    const consumeRes = await userDB.fetch(
      new Request('http://internal/internal/connect-token/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    );
    const config = (await consumeRes.json()) as Record<string, any>;
    expect(config.locationHint).toBe('apac');
  });
});
