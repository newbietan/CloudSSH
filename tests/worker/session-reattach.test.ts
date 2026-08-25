/// <reference lib="es2022" />
import { describe, expect, it, vi } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import { writeUint32 } from '../../src/ssh/utils';
import {
  SESSION_GRACE_PERIOD_MS,
  SESSION_RING_BUFFER_MAX_BYTES,
  SSH_MSG_CHANNEL_DATA,
  type SSHPacket,
} from '../../src/types';
import { SSHSessionDO } from '../../src/worker/durable-object';
import { SSHSession } from '../../src/worker/ssh-session';

if (typeof (globalThis as any).WebSocketPair === 'undefined') {
  (globalThis as any).WebSocketPair = class {
    0: any;
    1: any;
    constructor() {
      this[0] = { readyState: 1, send: vi.fn(), close: vi.fn() };
      this[1] = {
        readyState: 1,
        send: vi.fn(),
        close: vi.fn(),
        serializeAttachment: vi.fn(),
      };
    }
  };
}

const OriginalResponse = globalThis.Response;
class MockResponse extends OriginalResponse {
  private _mockStatus: number;
  // 基类 Response 要求 webSocket 为必填只读属性；此 Mock 在 101 升级时赋值。
  public webSocket: any;

  constructor(body?: any, init?: any) {
    if (init && init.status === 101) {
      super(null, { status: 200, headers: init.headers });
      this._mockStatus = 101;
      this.webSocket = init.webSocket;
    } else {
      super(body, init);
      this._mockStatus = init?.status ?? 200;
    }
  }

  get status(): number {
    return this._mockStatus;
  }
}
globalThis.Response = MockResponse as any;

function buildChannelDataPayload(channelId: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(1 + 4 + 4 + data.length);
  payload[0] = SSH_MSG_CHANNEL_DATA;
  writeUint32(payload, 1, channelId);
  writeUint32(payload, 5, data.length);
  payload.set(data, 9);
  return payload;
}

function createMockSession() {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
  const socket = { close: vi.fn() };
  const session = new SSHSession(
    ws as unknown as WebSocket,
    socket as never,
    {
      host: 'ssh.example.com',
      port: 22,
      username: 'alice',
      password: 'secret',
      authMethod: 'password',
    },
    true,
    false,
    undefined,
    undefined,
    'user-1',
    'gh-alice'
  );
  return { session, ws, socket };
}

describe('SSHSession Re-attach & Backpressure Flow Control', () => {
  it('buffers terminal output up to 128KB in detached state and pauses window adjust on limit', async () => {
    const { session, ws } = createMockSession();
    const internal = session as any;

    internal.state = 'ready';
    const channel = new SSHChannel();
    internal.shellChannel = channel;
    internal.channels.set(0, channel);

    const queueAdjustSpy = vi.spyOn(internal, 'queueLocalWindowAdjust');

    // 1. 设置为 detached 状态
    session.setDetached(true);
    expect(session.isDetached()).toBe(true);

    // 2. 构造 64KB 数据并模拟 SSH_MSG_CHANNEL_DATA
    const chunk1 = new Uint8Array(64 * 1024).fill(0x41);
    const payload1 = buildChannelDataPayload(0, chunk1);
    const packet1: SSHPacket = { length: payload1.length, paddingLength: 0, payload: payload1 };
    await internal.handlePacket(packet1);

    expect(ws.send).not.toHaveBeenCalled();
    expect(internal.detachedBufferBytes).toBe(64 * 1024);
    expect(queueAdjustSpy).toHaveBeenCalledWith(64 * 1024, channel);

    // 3. 再次发送 64KB 数据（累积刚好达到 128KB）
    const chunk2 = new Uint8Array(64 * 1024).fill(0x42);
    const payload2 = buildChannelDataPayload(0, chunk2);
    const packet2: SSHPacket = { length: payload2.length, paddingLength: 0, payload: payload2 };
    await internal.handlePacket(packet2);

    expect(internal.detachedBufferBytes).toBe(128 * 1024);
    expect(queueAdjustSpy).toHaveBeenCalledTimes(2);

    // 4. 再次发送数据（超出 128KB 预算）-> 触发背压暂停！
    queueAdjustSpy.mockClear();
    const chunk3 = new Uint8Array(1024).fill(0x43);
    const payload3 = buildChannelDataPayload(0, chunk3);
    const packet3: SSHPacket = { length: payload3.length, paddingLength: 0, payload: payload3 };
    await internal.handlePacket(packet3);

    expect(internal.unadjustedDetachedBytes).toBe(1024);
    expect(queueAdjustSpy).not.toHaveBeenCalled();

    // 5. 重新挂载新 WebSocket，验证一次性补发数据并恢复未调整的 window
    const newWs = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };

    const handleResizeSpy = vi.spyOn(internal, 'handleResize').mockResolvedValue(undefined);

    await session.reattachWebSocket(newWs as unknown as WebSocket, { cols: 100, rows: 30 });

    expect(session.isDetached()).toBe(false);
    expect(newWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'session_resumed' }));
    // 验证暂存的 2 个 64KB 块全部被刷到新 WebSocket
    expect(newWs.send).toHaveBeenCalledWith(chunk1);
    expect(newWs.send).toHaveBeenCalledWith(chunk2);
    // 验证积压的 1024 字节背压 window 被补发续借
    expect(queueAdjustSpy).toHaveBeenCalledWith(1024, channel);
    // 验证视口尺寸对齐
    expect(handleResizeSpy).toHaveBeenCalledWith(100, 30);
  });

  it('resets buffer and detached status when session is closed', () => {
    const { session, socket } = createMockSession();
    const internal = session as any;

    session.setDetached(true);
    internal.detachedOutputBuffer = [new Uint8Array(10)];
    internal.detachedBufferBytes = 10;
    internal.unadjustedDetachedBytes = 5;

    session.close(true);

    expect(session.isDetached()).toBe(false);
    expect(internal.detachedOutputBuffer.length).toBe(0);
    expect(internal.detachedBufferBytes).toBe(0);
    expect(internal.unadjustedDetachedBytes).toBe(0);
    expect(socket.close).toHaveBeenCalled();
  });

  it('records audit events for share session on detach and resume', async () => {
    const ws = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    const socket = { close: vi.fn() };
    const session = new SSHSession(
      ws as unknown as WebSocket,
      socket as never,
      {
        host: 'ssh.example.com',
        port: 22,
        username: 'bob',
        password: 'pwd',
        sessionPolicy: {
          source: 'share',
          shareId: 'share-123',
          shareRef: 'ref-456',
          allowAgent: false,
          allowSftp: true,
          allowMetadataMutation: false,
          allowHostKeyMutation: false,
          allowReconnect: false,
          sessionExpiresAt: Date.now() + 60000,
        },
      }
    );

    const internal = session as any;
    const writeAuditSpy = vi.spyOn(internal, 'writeShareAudit').mockResolvedValue(true);

    // 1. 断线设置 detached
    session.setDetached(true);
    expect(writeAuditSpy).toHaveBeenCalledWith('session.detached', expect.any(Object));

    // 2. 重连恢复
    writeAuditSpy.mockClear();
    const newWs = { readyState: 1, send: vi.fn(), close: vi.fn() };
    await session.reattachWebSocket(newWs as unknown as WebSocket);

    expect(writeAuditSpy).toHaveBeenCalledWith('session.resumed', expect.any(Object));
  });

});

describe('SSHSessionDO Re-attach Lifecycle & Security Authentication', () => {
  it('enters 60s grace period on abnormal close and rejects invalid resume token', async () => {
    const mockStorage = {
      sql: { exec: vi.fn() },
      setAlarm: vi.fn(),
    };
    const mockState = {
      storage: mockStorage,
      acceptWebSocket: vi.fn(),
      waitUntil: vi.fn(),
    };
    const mockEnv = {
      STRICT_HOST_KEY_VERIFY: 'false',
      DEBUG_MODE: 'false',
    };

    const doInstance = new SSHSessionDO(mockState as any, mockEnv as any);
    const internal = doInstance as any;

    const { session, ws, socket } = createMockSession();
    internal.sessions.set(ws, session);
    internal.sessionChains.set(ws, [session]);

    const sessionId = 'session:1724400000:test';
    const resumeToken = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
    internal.sessionToSessionId.set(session, sessionId);
    internal.sessionToResumeToken.set(session, resumeToken);

    // 标记 session 为 ready
    (session as any).state = 'ready';

    // 模拟异常断开 (code 1006, wasClean false)
    await doInstance.webSocketClose(ws as unknown as WebSocket, 1006, 'Abnormal', false);

    // 验证底层 TCP 未被销毁，进入 detachedSessions
    expect(socket.close).not.toHaveBeenCalled();
    expect(session.isDetached()).toBe(true);
    expect(internal.detachedSessions.has(sessionId)).toBe(true);

    // 1. 使用错误的 resumeToken 尝试恢复 -> 403 Forbidden
    const invalidResumeReq = new Request(
      `https://cloudssh.dev/api/ssh?session=${sessionId}&resume_token=wrong_token&cols=80&rows=24`,
      { headers: { Upgrade: 'websocket' } }
    );
    const res403 = await doInstance.fetch(invalidResumeReq);
    expect(res403.status).toBe(403);

    // 2. 使用正确的 resumeToken 恢复 -> 101 Switching Protocols
    const validResumeReq = new Request(
      `https://cloudssh.dev/api/ssh?session=${sessionId}&resume_token=${resumeToken}&cols=100&rows=30`,
      { headers: { Upgrade: 'websocket' } }
    );
    const res101 = await doInstance.fetch(validResumeReq);
    expect(res101.status).toBe(101);
    expect(internal.detachedSessions.has(sessionId)).toBe(false);
  });

  it('immediately destroys session on normal close (code 1000)', async () => {
    const mockState = {
      storage: { sql: { exec: vi.fn() } },
      acceptWebSocket: vi.fn(),
      waitUntil: vi.fn(),
    };
    const mockEnv = {};
    const doInstance = new SSHSessionDO(mockState as any, mockEnv as any);
    const internal = doInstance as any;

    const { session, ws, socket } = createMockSession();
    internal.sessions.set(ws, session);
    internal.sessionChains.set(ws, [session]);

    const sessionId = 'session:1724400000:normal';
    const resumeToken = 'secret123';
    internal.sessionToSessionId.set(session, sessionId);
    internal.sessionToResumeToken.set(session, resumeToken);
    (session as any).state = 'ready';

    // 模拟正常主动退出 (code 1000, wasClean true)
    await doInstance.webSocketClose(ws as unknown as WebSocket, 1000, 'Normal', true);

    // 验证底层连接立即完全销毁，不进入 60s 等待
    expect(socket.close).toHaveBeenCalled();
    expect(internal.detachedSessions.has(sessionId)).toBe(false);
  });
});
