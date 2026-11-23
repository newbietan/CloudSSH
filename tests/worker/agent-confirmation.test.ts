/// <reference lib="es2022" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { SSHSession } from '../../src/worker/ssh-session';

function fixture(idleTimeout = '10s') {
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  const socket = { close: vi.fn() };
  const session = new SSHSession(ws as unknown as WebSocket, socket as never, {
    host: 'ssh.example.com', port: 22, username: 'alice', authMethod: 'password', password: 'secret',
  }, false, undefined, { IDLE_TIMEOUT: idleTimeout } as Env);
  const internal = session as any;
  internal.state = 'ready';
  internal.agentCore = { getStatus: () => 'running', agentAbort: vi.fn(), resetSession: vi.fn() };
  return { session, internal, ws, socket };
}
function request(ws: { send: ReturnType<typeof vi.fn> }) {
  return ws.send.mock.calls.map(([frame]) => JSON.parse(frame))
    .filter(frame => frame.subType === 'confirm_required').at(-1);
}

describe('Agent one-shot confirmation and user idle policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('only exact ID + command + boolean can resolve, and stale frames do not refresh activity', async () => {
    const { session, internal, ws } = fixture();
    const pending = internal.askAgentConfirmation('rm file', 'delete');
    const frame = request(ws);
    const before = session.getLastUserActivityAt();
    vi.advanceTimersByTime(100);
    for (const message of [
      { approved: true, command: frame.command },
      { approved: true, command: frame.command, confirmationId: 'wrong' },
      { approved: true, command: 'rm other', confirmationId: frame.confirmationId },
      { approved: 'true', command: frame.command, confirmationId: frame.confirmationId },
    ]) session.handleAgentControl('agent_confirm', message);
    expect(internal.pendingAgentConfirmation).not.toBeNull();
    expect(session.getLastUserActivityAt()).toBe(before);
    session.handleAgentControl('agent_confirm', { ...frame, approved: true });
    expect(await pending).toBe(true);
    expect(internal.pendingAgentConfirmation).toBeNull();
    session.close(true);
  });

  it('repeated identical commands have distinct IDs; duplicate approval cannot approve the next', async () => {
    const { session, internal, ws } = fixture();
    const first = internal.askAgentConfirmation('rm file', 'delete');
    const old = request(ws);
    session.handleAgentControl('agent_confirm', { ...old, approved: true });
    expect(await first).toBe(true);
    const next = internal.askAgentConfirmation('rm file', 'delete');
    const current = request(ws);
    expect(current.confirmationId).not.toBe(old.confirmationId);
    session.handleAgentControl('agent_confirm', { ...old, approved: true });
    expect(internal.pendingAgentConfirmation.id).toBe(current.confirmationId);
    session.handleAgentControl('agent_confirm', { ...current, approved: false });
    expect(await next).toBe(false);
    session.close(true);
  });

  it('waiting confirmation no longer bypasses IDLE_TIMEOUT; pings do not keep it alive', async () => {
    const { session, internal, ws, socket } = fixture();
    const pending = internal.askAgentConfirmation('rm file', 'delete');
    const before = session.getLastUserActivityAt();
    internal.startIdleWatchdog();
    vi.advanceTimersByTime(7500);
    await session.handleWebSocketMessage('{"type":"ping"}');
    expect(session.getLastUserActivityAt()).toBe(before);
    vi.advanceTimersByTime(2500);
    expect(await pending).toBe(false);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledWith(1000);
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('session_idle_timeout'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('real execution still keeps delegated work alive; valid interaction renews a waiting budget', async () => {
    const { session, internal, ws } = fixture();
    internal.startIdleWatchdog();
    vi.advanceTimersByTime(20_000);
    expect(ws.close).not.toHaveBeenCalled();
    const pending = internal.askAgentConfirmation('rm file', 'delete');
    vi.advanceTimersByTime(7500);
    session.recordUserActivity();
    vi.advanceTimersByTime(7500);
    expect(ws.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    expect(await pending).toBe(false);
  });

  it('IDLE_TIMEOUT=0 remains an explicit opt-out, not a hidden new confirmation timer', async () => {
    const { session, internal, ws } = fixture('0');
    const pending = internal.askAgentConfirmation('rm file', 'delete');
    internal.startIdleWatchdog();
    for (let i = 0; i < 20; i++) {
      internal.lastPacketAt = Date.now();
      vi.advanceTimersByTime(10_000);
    }
    expect(ws.close).not.toHaveBeenCalled();
    session.handleAgentControl('agent_stop', {});
    expect(await pending).toBe(false);
    session.close(true);
  });

  it.each(['agent_stop', 'agent_reset', 'close', 'abort'])(
    '%s clears the pending slot and abort listener', async action => {
      const { session, internal, ws } = fixture();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const pending = internal.askAgentConfirmation('rm file', 'delete', controller.signal);
      const frame = request(ws);
      if (action === 'close') session.close(true);
      else if (action === 'abort') controller.abort('superseded');
      else session.handleAgentControl(action, {});
      expect(await pending).toBe(false);
      expect(internal.pendingAgentConfirmation).toBeNull();
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'agent_frame', subType: 'confirm_closed', confirmationId: frame.confirmationId,
      }));
      session.close(true);
    }
  );
});
