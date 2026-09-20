import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSHConnectionConfig } from '../../src/types';

const { checkHostResolvedMock } = vi.hoisted(() => ({
  checkHostResolvedMock: vi.fn(),
}));

vi.mock('../../src/worker/dns-check', () => ({
  checkHostResolved: checkHostResolvedMock,
}));

import { SSHSessionDO } from '../../src/worker/durable-object';

class MockBrowserWs {
  readyState = 1;
  sentMessages: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  send(msg: string) {
    this.sentMessages.push(msg);
  }

  close(code: number, reason: string) {
    this.closedWith = { code, reason };
  }
}

class MockTunnelWs {
  readyState = 1;
  binaryType = 'blob';
  accepted = false;

  accept() {
    this.accepted = true;
  }

  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

function createSSHSessionDO() {
  const mockState = {
    waitUntil: vi.fn(),
  };
  const mockEnv = {
    STRICT_HOST_KEY_VERIFY: 'false',
    DEBUG_MODE: 'false',
  };
  return new SSHSessionDO(mockState as any, mockEnv as any);
}

describe('SSHSessionDO - Cloudflare 隧道连接', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkHostResolvedMock.mockResolvedValue({ blocked: false });
  });

  it('阻止带有跳板机配置的隧道连接请求', async () => {
    const doInstance = createSSHSessionDO();
    const ws = new MockBrowserWs();

    const config: SSHConnectionConfig = {
      host: 'ssh.example.com',
      port: 22,
      username: 'root',
      password: 'pwd',
      transportType: 'cf_tunnel',
      jumpHosts: [
        {
          serverId: 1,
          name: 'jump',
          host: '1.2.3.4',
          port: 22,
          username: 'jump',
          password: 'pwd',
          authMethod: 'password',
          privateKey: '',
          knownHostIdentity: '1.2.3.4',
        },
      ],
    };

    // 模拟内部 initSSHSession（私有方法通过 any 调用）
    await (doInstance as any).initSSHSession(ws, config);

    expect(ws.closedWith?.code).toBe(1011);
    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastMsg.message).toContain('Cloudflare 隧道连接不支持跳板机');
  });

  it('隧道域名格式不合法时拒绝连接', async () => {
    const doInstance = createSSHSessionDO();
    const ws = new MockBrowserWs();

    const config: SSHConnectionConfig = {
      host: '192.168.1.1',
      port: 22,
      username: 'root',
      password: 'pwd',
      transportType: 'cf_tunnel',
    };

    await (doInstance as any).initSSHSession(ws, config);

    expect(ws.closedWith?.code).toBe(1011);
    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastMsg.message).toContain('域名格式不正确');
  });

  it('隧道域名解析命中内网/保留地址时触发 SSRF 拦截', async () => {
    const doInstance = createSSHSessionDO();
    const ws = new MockBrowserWs();

    checkHostResolvedMock.mockResolvedValue({
      blocked: true,
      reason: '禁止连接内网或保留地址 (SSRF 防护)',
    });

    const config: SSHConnectionConfig = {
      host: 'internal.tunnel.local',
      port: 22,
      username: 'root',
      password: 'pwd',
      transportType: 'cf_tunnel',
    };

    await (doInstance as any).initSSHSession(ws, config);

    expect(ws.closedWith?.code).toBe(1011);
    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastMsg.message).toContain('SSRF');
  });

  it('Cloudflare Zero Trust 返回 403 时向客户端提供友好的 Service Token 提示', async () => {
    const doInstance = createSSHSessionDO();
    const ws = new MockBrowserWs();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
    );

    const config: SSHConnectionConfig = {
      host: 'ssh.zero-trust.example.com',
      port: 22,
      username: 'root',
      password: 'pwd',
      transportType: 'cf_tunnel',
    };

    await (doInstance as any).initSSHSession(ws, config);

    expect(ws.closedWith?.code).toBe(1011);
    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastMsg.message).toContain('Service Token');

    fetchSpy.mockRestore();
  });

  it('Cloudflare Zero Trust 返回 302 重定向时向客户端提示配置 Access 策略', async () => {
    const doInstance = createSSHSessionDO();
    const ws = new MockBrowserWs();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://example.cloudflareaccess.com' },
      })
    );

    const config: SSHConnectionConfig = {
      host: 'ssh.zero-trust.example.com',
      port: 22,
      username: 'root',
      password: 'pwd',
      transportType: 'cf_tunnel',
    };

    await (doInstance as any).initSSHSession(ws, config);

    expect(ws.closedWith?.code).toBe(1011);
    const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(lastMsg.message).toContain('重定向到认证页面');

    fetchSpy.mockRestore();
  });

  it('正常出站连接时正确携带 Service Token Headers 并升级 WebSocket', async () => {
    const doInstance = createSSHSessionDO();
    const ws = new MockBrowserWs();

    const mockTunnelWs = new MockTunnelWs();
    let capturedHeaders: Headers | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedHeaders = new Headers(init?.headers as any);
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, 'webSocket', { value: mockTunnelWs, configurable: true });
      return res;
    });

    const config: SSHConnectionConfig = {
      host: 'ssh.tunnel.com',
      port: 22,
      username: 'root',
      password: 'pwd',
      transportType: 'cf_tunnel',
      cfAccessClientId: 'test-id.access',
      cfAccessClientSecret: 'test-secret-12345',
    };

    // initSSHSession 会在 handshake 时挂起（等待远端版本号），我们捕获隧道连接成功的一刻即可
    void (doInstance as any).initSSHSession(ws, config);

    // 等待微任务完成
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    expect(capturedHeaders?.get('Upgrade')).toBe('websocket');
    expect(capturedHeaders?.get('CF-Access-Client-Id')).toBe('test-id.access');
    expect(capturedHeaders?.get('CF-Access-Client-Secret')).toBe('test-secret-12345');
    expect(mockTunnelWs.accepted).toBe(true);

    fetchSpy.mockRestore();
  });
});
