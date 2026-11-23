/// <reference lib="es2022" />
import { describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';

function createTestSession(options?: {
  ownsWebSocket?: boolean;
  colo?: string;
  onRttUpdated?: (latency: number, colo: string) => void;
}) {
  const sent: string[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
  };
  const socket = { close: vi.fn() };
  const session = new SSHSession(
    ws as unknown as WebSocket,
    socket as never,
    {
      host: 'target.example.com',
      port: 22,
      username: 'test',
      password: 'pwd',
      authMethod: 'password',
    },
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      openShellOnAuth: true,
      ownsWebSocket: options?.ownsWebSocket !== false,
      colo: options?.colo || 'HKG',
      onRttUpdated: options?.onRttUpdated,
    }
  );
  return { session, ws, socket, sent };
}

describe('SSH Keepalive 周期性 RTT 刷新机制', () => {
  it('收到 keepalive 响应 (REQUEST_SUCCESS / FAILURE) 时计算并广播 RTT', async () => {
    const onRttUpdated = vi.fn();
    const { session, sent } = createTestSession({ colo: 'HKG', onRttUpdated });
    const internal = session as any;

    internal.state = 'ready';
    internal.sendEncrypted = vi.fn(async () => {});

    // 触发单次 keepalive 发送
    internal.keepaliveSentAt = performance.now() - 42;
    internal.keepalivePending = true;

    // 收到服务端的 REQUEST_FAILURE (OpenSSH 典型行为)
    await internal.handlePacket({
      length: 1,
      paddingLength: 0,
      payload: new Uint8Array([82]), // SSH_MSG_REQUEST_FAILURE
    });

    expect(internal.keepalivePending).toBe(false);
    expect(internal.keepaliveSentAt).toBeNull();
    expect(onRttUpdated).toHaveBeenCalledTimes(1);
    const [reportedLatency, reportedColo] = onRttUpdated.mock.calls[0];
    expect(reportedLatency).toBeGreaterThanOrEqual(40);
    expect(reportedColo).toBe('HKG');

    const rttMessages = sent
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter((m) => m?.type === 'rtt');

    expect(rttMessages.length).toBe(1);
    expect(rttMessages[0].colo).toBe('HKG');
    expect(rttMessages[0].latency).toBe(reportedLatency);
  });

  it('收到 REQUEST_SUCCESS 时同样正确计算并发送 RTT', async () => {
    const onRttUpdated = vi.fn();
    const { session, sent } = createTestSession({ colo: 'SJC', onRttUpdated });
    const internal = session as any;

    internal.state = 'ready';
    internal.keepaliveSentAt = performance.now() - 88;
    internal.keepalivePending = true;

    await internal.handlePacket({
      length: 1,
      paddingLength: 0,
      payload: new Uint8Array([81]), // SSH_MSG_REQUEST_SUCCESS
    });

    expect(internal.keepalivePending).toBe(false);
    expect(onRttUpdated).toHaveBeenCalledTimes(1);
    expect(onRttUpdated.mock.calls[0][1]).toBe('SJC');

    const rttMessage = sent.map((s) => JSON.parse(s)).find((m) => m?.type === 'rtt');
    expect(rttMessage).toBeDefined();
    expect(rttMessage.colo).toBe('SJC');
    expect(rttMessage.latency).toBeGreaterThanOrEqual(80);
  });

  it('非 WebSocket 持有者（如跳板机 hopSession）不向前端推送 rtt 消息', async () => {
    const onRttUpdated = vi.fn();
    const { session, sent } = createTestSession({
      ownsWebSocket: false,
      colo: 'HKG',
      onRttUpdated,
    });
    const internal = session as any;

    internal.state = 'tunnel-ready';
    internal.keepaliveSentAt = performance.now() - 30;
    internal.keepalivePending = true;

    await internal.handlePacket({
      length: 1,
      paddingLength: 0,
      payload: new Uint8Array([82]),
    });

    // 跳板 session 不应向客户端 WebSocket 发送消息
    const rttMessages = sent.filter((s) => s.includes('"type":"rtt"'));
    expect(rttMessages.length).toBe(0);
    // 但如果有传入 onRttUpdated 仍会触发
    expect(onRttUpdated).toHaveBeenCalledTimes(1);
  });

  it('会话处于断线暂存态 (detached) 时不向失效 ws 发送 rtt，但仍触发 onRttUpdated 更新 DO 基线', async () => {
    const onRttUpdated = vi.fn();
    const { session, sent } = createTestSession({ colo: 'NRT', onRttUpdated });
    const internal = session as any;

    session.setDetached(true);
    internal.keepaliveSentAt = performance.now() - 25;
    internal.keepalivePending = true;

    await internal.handlePacket({
      length: 1,
      paddingLength: 0,
      payload: new Uint8Array([82]),
    });

    expect(sent.filter((s) => s.includes('"type":"rtt"')).length).toBe(0);
    expect(onRttUpdated).toHaveBeenCalledTimes(1);
    expect(onRttUpdated.mock.calls[0][1]).toBe('NRT');
  });

  it('reattachWebSocket 恢复新连接后，后续 keepalive 更新能正确送达新 ws', async () => {
    const onRttUpdated = vi.fn();
    const { session } = createTestSession({ colo: 'HKG', onRttUpdated });
    const internal = session as any;

    const newSent: string[] = [];
    const newWs = {
      readyState: 1,
      send: vi.fn((data: string) => newSent.push(data)),
      close: vi.fn(),
    };

    // 重新连接并传入最新基线
    await session.reattachWebSocket(newWs as unknown as WebSocket, null, {
      baseline: { latencyMs: 50, colo: 'HKG' },
    });

    // reattach 应该首先发送初次基线
    const initialRtt = newSent.map((s) => JSON.parse(s)).find((m) => m?.type === 'rtt');
    expect(initialRtt).toEqual({ type: 'rtt', latency: 50, colo: 'HKG' });

    // 新的 keepalive 响应到来
    internal.keepaliveSentAt = performance.now() - 35;
    internal.keepalivePending = true;

    await internal.handlePacket({
      length: 1,
      paddingLength: 0,
      payload: new Uint8Array([82]),
    });

    const refreshedRtt = newSent
      .map((s) => JSON.parse(s))
      .filter((m) => m?.type === 'rtt')
      .slice(-1)[0];
    expect(refreshedRtt.latency).toBeGreaterThanOrEqual(30);
    expect(refreshedRtt.colo).toBe('HKG');
  });
});
