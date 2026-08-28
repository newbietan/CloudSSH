/**
 * 跳板会话就绪时序回归测试（#108 / PR #109）。
 *
 * v1.11.0 重构误删了跳板循环中的 `await hopSession.waitUntilAuthenticated()`，
 * 导致 openDirectTcpip 在认证完成（state === 'tunnel-ready'）前被调用，
 * 跳板连接必现 "SSH jump host is not ready for TCP forwarding"。
 *
 * 本文件锁定 SSHSession 与 DO 跳板循环（initSSHSession）之间的时序契约：
 *  1. 认证完成前 openDirectTcpip 必须被状态门拒绝；
 *  2. 认证前关闭会话时 waitUntilAuthenticated 以明确错误拒绝（等待有界，不挂死）；
 *  3. USERAUTH_SUCCESS（openShellOnAuth=false）后进入 tunnel-ready 且等待兑现。
 */
import { describe, expect, it, vi } from 'vitest';
import { SSH_MSG_USERAUTH_SUCCESS, type SSHPacket } from '../../src/types';
import { SSHSession } from '../../src/worker/ssh-session';

function createHopSession() {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
  const socket = { close: vi.fn() };
  // 与 initSSHSession 跳板循环一致：中间节点不启动 Shell，仅做隧道转发
  const session = new SSHSession(
    ws as unknown as WebSocket,
    socket as never,
    {
      host: 'jump.example.com',
      port: 22,
      username: 'jump-user',
      password: 'secret',
      authMethod: 'password',
    },
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      openShellOnAuth: false,
      ownsWebSocket: false,
      allowKeyboardInteractive: false,
    }
  );
  return { session, ws, socket };
}

const successPacket = (): SSHPacket => ({
  length: 5,
  paddingLength: 4,
  payload: new Uint8Array([SSH_MSG_USERAUTH_SUCCESS]),
});

describe('跳板会话就绪时序（#108 / PR #109 回归）', () => {
  it('认证完成前 openDirectTcpip 被状态门拒绝（回归主断言）', async () => {
    const { session } = createHopSession();
    await expect(session.openDirectTcpip('10.0.0.5', 22)).rejects.toThrow(
      'SSH jump host is not ready for TCP forwarding'
    );
  });

  it('认证前关闭会话：waitUntilAuthenticated 以明确错误拒绝（等待有界，不挂死）', async () => {
    const { session } = createHopSession();
    const pending = session.waitUntilAuthenticated();
    session.close(false);
    await expect(pending).rejects.toThrow('SSH session closed before authentication completed');
  });

  it('USERAUTH_SUCCESS（openShellOnAuth=false）后进入 tunnel-ready，等待兑现且状态门放行', async () => {
    const { session } = createHopSession();
    // 跳板会话真实时序：KEX 完成后进入 auth 态，等待认证结果；
    // handlePacket 主分发按 state 路由（connecting 态不处理用户认证消息）
    (session as any).state = 'auth';
    // keepalive 依赖真实传输，与就绪时序无关，桩掉避免悬挂定时器
    (session as any).startKeepalive = vi.fn();
    await (session as any).handlePacket(successPacket());

    expect((session as any).state).toBe('tunnel-ready');
    await expect(session.waitUntilAuthenticated()).resolves.toBeUndefined();
    await expect(session.openDirectTcpip('10.0.0.5', 22)).rejects.not.toThrow(
      /not ready for TCP forwarding/
    );
  });
});
