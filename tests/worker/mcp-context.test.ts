import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';

function fixture() {
  const session = new SSHSession({ readyState: 1, send: vi.fn(), close: vi.fn() }, { close: vi.fn() }, {
    host: 'ssh.example.com', port: 22, username: 'test', password: '', serverId: 1, userDbRouteKey: 'cf-owner',
  }, true, false, undefined, undefined, '7', '-2');
  const state = session as any;
  state.state = 'ready';
  state.terminalContext.appendOutput('private recent output\n');
  return { session, state, input: { userId: 7, routeKey: 'cf-owner', serverId: 1 } };
}
afterEach(() => vi.restoreAllMocks());
describe('explicit browser terminal context sharing', () => {
  it('defaults closed and scopes both mutation and reads to owner, route and saved server', () => {
    const { session, input } = fixture();
    expect(session.mcpContext(input)).toBeNull();
    expect(session.mcpContext({ ...input, inspect: true })).toEqual({ expiresAt: 0 });
    expect(session.mcpContext({ ...input, enabled: true })!.expiresAt).toBeGreaterThan(Date.now());
    for (const wrong of [{ userId: 8 }, { routeKey: 'cf-other' }, { serverId: 2 }]) {
      expect(session.mcpContext({ ...input, ...wrong })).toBeNull();
      expect(session.mcpContext({ ...input, ...wrong, enabled: false })).toBeNull();
    }
    expect(session.mcpContext(input)).toMatchObject({ output: 'private recent output', bounded: true });
    session.mcpContext({ ...input, enabled: false });
    expect(session.mcpContext(input)).toBeNull();
  });
  it('bounds output, expires in 30 minutes and reads/inspection never refresh inactivity', () => {
    const { session, state, input } = fixture();
    const { expiresAt } = session.mcpContext({ ...input, enabled: true })!;
    const recorded = vi.spyOn(session, 'recordUserActivity');
    state.terminalContext.appendOutput('x'.repeat(70_000));
    expect(session.mcpContext({ ...input, lastLines: 999 })!.output!.length).toBeLessThan(16_100);
    session.mcpContext({ ...input, inspect: true });
    expect(recorded).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
    expect(session.mcpContext(input)).toBeNull();
  });
  it('does not expose shared sessions, detached sessions or new shells', () => {
    const { session, state, input } = fixture();
    session.mcpContext({ ...input, enabled: true });
    session.setDetached(true);
    session.setDetached(false);
    expect(session.mcpContext(input)).toBeNull();
    state.config.sessionPolicy = { source: 'share' };
    expect(session.mcpContext({ ...input, enabled: true })).toBeNull();
    state.config.sessionPolicy = undefined;
    state.state = 'auth';
    expect(session.mcpContext({ ...input, enabled: true })).toBeNull();
  });
});
