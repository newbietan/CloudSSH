import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';
import { SSH_MSG_CHANNEL_OPEN_CONFIRMATION, SSH_MSG_CHANNEL_SUCCESS, type SSHPacket } from '../../src/types';

function fixture() {
  const session = new SSHSession({ readyState: 1, send: vi.fn(), close: vi.fn() }, { close: vi.fn() },
    { host: 'ssh.example.com', port: 22, username: 'test', password: '' }, false, undefined, undefined, undefined, undefined,
    { openShellOnAuth: false, ownsWebSocket: false, allowKeyboardInteractive: false });
  const state = session as any;
  state.state = 'tunnel-ready';
  const sent = vi.spyOn(state, 'sendEncrypted').mockResolvedValue(undefined);
  return { session, state, sent };
}
afterEach(() => vi.useRealTimers());
describe('headless SSH operation channels', () => {
  it('opens SFTP on its own subsystem and waits for confirmation, never allocating PTY or Shell', async () => {
    const { session, state, sent } = fixture();
    const pending = session.openSftpStream();
    const channel = state.channels.get(1);
    vi.spyOn(channel, 'handleOpenConfirmation').mockImplementation(() => {});
    const subsystem = vi.spyOn(channel, 'buildSubsystemRequest');
    const pty = vi.spyOn(channel, 'buildPTYRequest');
    const packet = (type: number): SSHPacket => ({ length: 5, paddingLength: 4, payload: new Uint8Array([type, 0, 0, 0, 1]) });
    await state.handlePacket(packet(SSH_MSG_CHANNEL_OPEN_CONFIRMATION));
    expect(subsystem).toHaveBeenCalledWith('sftp');
    expect(state.pendingDirectTcpip.has(1)).toBe(true);
    await state.handlePacket(packet(SSH_MSG_CHANNEL_SUCCESS));
    const stream = await pending;
    expect(state.pendingDirectTcpip.size).toBe(0);
    expect(pty).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalled();
    stream.close(); session.close(true);
  });
  it('cleans exec maps, timers and listeners after timeout; late open cannot execute a command', async () => {
    vi.useFakeTimers();
    const { session, state, sent } = fixture();
    const running = session.executeCommand('must-not-execute', 1000);
    const outcome = expect(running).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1001);
    await outcome;
    expect(state.activeExecChannels.size).toBe(0);
    expect(state.channels.size).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    expect(sent).toHaveBeenCalledOnce(); // Only channel OPEN; never exec.
    expect(vi.getTimerCount()).toBe(0);
    session.close(true);
  });
  it('closes only the opened exec channel on cancellation and preserves the SSH connection', async () => {
    const { session, state } = fixture();
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    vi.spyOn(state, 'sendEncrypted').mockImplementation(async (payload: unknown) => {
      const bytes = payload as Uint8Array;
      if (bytes[0] === 90) {
        const channel = state.activeExecChannels.get(1); channel.onOpenConfirmation();
      }
      if (bytes[0] === 98) opened();
    });
    const controller = new AbortController();
    const running = session.executeCommand('sleep 100', 10_000, controller.signal);
    await ready;
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    expect(state.closed).toBe(false);
    expect(state.activeExecChannels.size).toBe(0);
    session.close(true);
  });
});
