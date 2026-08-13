import { describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';

const OLD_FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
const NEW_FINGERPRINT = `SHA256:${'B'.repeat(43)}`;

function createSession(expectedFingerprint?: string, knownHostIdentity?: string) {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
  const socket = { close: vi.fn() };
  const session = new SSHSession(
    ws as unknown as WebSocket,
    socket,
    {
      host: '10.0.0.2',
      port: 22,
      username: 'root',
      password: 'secret',
      expectedFingerprint,
      knownHostIdentity,
    },
  );
  (session as any).hostKeyFingerprint = NEW_FINGERPRINT;
  (session as any).hostKeyType = 'ssh-ed25519';
  return { session, ws, socket };
}

function sentMessages(ws: { send: ReturnType<typeof vi.fn> }): any[] {
  return ws.send.mock.calls.map(([message]) => JSON.parse(message as string));
}

describe('SSHSession 主机密钥 TOFU', () => {
  it('首次连接只在签名验证通过后发布可持久化指纹', () => {
    const verified = createSession();
    expect((verified.session as any).finalizeHostKeyTrust(true)).toBe(true);
    expect(sentMessages(verified.ws)).toContainEqual(expect.objectContaining({
      type: 'host_key_verified',
      fingerprint: NEW_FINGERPRINT,
      host: '10.0.0.2',
      displayHost: '10.0.0.2',
      port: 22,
      firstSeen: true,
    }));

    const unverified = createSession();
    expect((unverified.session as any).finalizeHostKeyTrust(false)).toBe(true);
    expect(sentMessages(unverified.ws).some((message) => message.type === 'host_key_verified'))
      .toBe(false);
    expect(sentMessages(unverified.ws)).toContainEqual(expect.objectContaining({
      type: 'status',
      event: 'host_key_not_saved',
    }));
  });

  it('指纹变更时发布精确路由信息并正常关闭，等待用户明确确认', () => {
    const routeIdentity = 'jump:1@bastion.example.com:22|10.0.0.2';
    const { session, ws, socket } = createSession(OLD_FINGERPRINT, routeIdentity);

    expect((session as any).finalizeHostKeyTrust(true)).toBe(false);

    expect(sentMessages(ws)).toContainEqual(expect.objectContaining({
      type: 'host_key_changed',
      fingerprint: NEW_FINGERPRINT,
      expectedFingerprint: OLD_FINGERPRINT,
      host: routeIdentity,
      displayHost: '10.0.0.2',
    }));
    expect(sentMessages(ws).some((message) => message.type === 'host_key_verified')).toBe(false);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledWith(1000);
  });

  it('已知指纹匹配时不重复写入信任记录', () => {
    const { session, ws } = createSession(NEW_FINGERPRINT);

    expect((session as any).finalizeHostKeyTrust(true)).toBe(true);

    expect(sentMessages(ws)).toEqual([
      expect.objectContaining({ type: 'status', event: 'host_key_accepted' }),
    ]);

    const unverified = createSession(NEW_FINGERPRINT);
    expect((unverified.session as any).finalizeHostKeyTrust(false)).toBe(true);
    expect(sentMessages(unverified.ws)).toEqual([
      expect.objectContaining({
        type: 'status',
        event: 'host_key_fingerprint_matched_unverified',
      }),
    ]);
  });
});
