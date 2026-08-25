import { describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';

function createSession(stdout: string) {
  const send = vi.fn();
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      Response.json({ success: true })
  );
  const env = {
    USER_DB: {
      idFromName: vi.fn(() => 'user-db-id'),
      get: vi.fn(() => ({ fetch })),
    },
  };
  const config = {
    host: 'ssh.example.com',
    port: 22,
    username: 'alice',
    password: 'secret',
    serverId: 9,
    os: null,
  };
  const session = new SSHSession(
    { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
    {} as never,
    config,
    true,
    false,
    undefined,
    env as never,
    '7',
    '99'
  );
  (session as any).executeAgentCommand = vi.fn(async () => ({
    stdout,
    stderr: 'Ubuntu error text must not be parsed',
    exitCode: stdout ? 0 : 1,
  }));

  return { session, config, send, fetch };
}

describe('SSHSession OS detection', () => {
  it('识别成功后持久化并通知前端', async () => {
    const { session, config, send, fetch } = createSession('ID=debian\n');

    await (session as any).detectRemoteOS();

    expect(config.os).toBe('debian');
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][0] as Request;
    await expect(request.json()).resolves.toEqual({ user_id: 7, os: 'debian' });
    expect(send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'os_detected',
        serverId: 9,
        os: 'debian',
      })
    );
  });

  it('unknown 不持久化也不通知，留待下次连接重新探测', async () => {
    const { session, config, send, fetch } = createSession('');

    await (session as any).detectRemoteOS();

    expect(config.os).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
