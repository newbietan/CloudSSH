import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, SSHConnectionConfig } from '../../src/types';
import { MCPExecutionDO } from '../../src/worker/mcp-execution';
import { SSHSession } from '../../src/worker/ssh-session';
import { checkHostResolved } from '../../src/worker/dns-check';

vi.mock('../../src/worker/dns-check', () => ({ checkHostResolved: vi.fn(async () => ({ blocked: false })) }));
vi.mock('../../src/worker/ssh-session', () => ({ SSHSession: vi.fn(class {
  close = vi.fn(); startHandshake = vi.fn(async () => {}); waitUntilAuthenticated = vi.fn(async () => {});
  isOperational = vi.fn(() => true);
  executeCommand = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
}) }));
vi.mock('../../src/worker/tunnel-stream', () => ({ isValidTunnelHostname: (host: string) => host === 'ssh.example.com',
  TunnelWebSocketStream: class { opened = Promise.resolve(); close = vi.fn(); } }));

function fixture() {
  let valid = true;
  const config: SSHConnectionConfig = { host: 'ssh.example.com', port: 22, username: 'test', password: '',
    authMethod: 'password', expectedFingerprint: 'SHA256:trusted', transportType: 'cf_tunnel' };
  const principal = { id: 'id', name: 'Claude Code', userId: 7, routeKey: '42', modeTag: 'github',
    scopes: ['read', 'exec', 'write'], serverIds: [1, 2, 3], grants: [1, 2, 3].map(serverId => ({ serverId, scopes: ['read', 'exec', 'write'] })), expiresAt: Number.MAX_SAFE_INTEGER };
  const rows: any[] = [];
  const internal = vi.fn(async (request: Request) => {
    const body = await request.json() as any;
    if (body.action === 'record') { rows.push(body.activity); return Response.json({ success: true }); }
    if (!valid) return Response.json({ error: 'unauthorized' }, { status: 401 });
    return Response.json(body.action === 'config' ? config : principal);
  });
  const pending: Promise<unknown>[] = [];
  const state = { storage: { setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) },
    waitUntil: (p: Promise<unknown>) => pending.push(p) };
  const env = { USER_DB: { idFromName: (name: string) => name, get: () => ({ fetch: internal }) } } as unknown as Env;
  const object = new MCPExecutionDO(state as unknown as DurableObjectState, env);
  const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 101, webSocket: { accept: vi.fn() } }));
  vi.stubGlobal('fetch', fetchSpy);
  const call = (args: Record<string, unknown> = {}, signal?: AbortSignal) => object.fetch(new Request('https://internal/execute', {
    method: 'POST', signal, body: JSON.stringify({ token: `mcp_42:${'a'.repeat(64)}`, modeTag: 'github', tool: 'ssh_exec',
      args: { server_id: 1, command: 'pwd', ...args } }),
  }));
  return { object, config, principal, call, fetchSpy, state, rows, pending, revoke: () => { valid = false; } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('bounded headless MCP execution', () => {
  it('uses strict host-key verification, no PTY/browser prompts and reuses only unchanged configurations', async () => {
    const f = fixture();
    expect((await f.call()).ok).toBe(true);
    expect((await f.call()).ok).toBe(true);
    expect(f.fetchSpy).toHaveBeenCalledOnce();
    expect(SSHSession).toHaveBeenCalledOnce();
    const constructed = vi.mocked(SSHSession).mock.calls[0];
    expect(constructed[2].expectedFingerprint).toBe(f.config.expectedFingerprint);
    expect(constructed[8]).toMatchObject({ openShellOnAuth: false, ownsWebSocket: false, allowKeyboardInteractive: false });
    f.config.password = 'rotated';
    expect((await f.call()).ok).toBe(true);
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);
    expect(f.fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    await Promise.all(f.pending);
    expect(f.rows.map(row => row.status)).toContain('running');
    expect(f.rows.at(-1).status).toBe('success');
    expect(JSON.stringify(f.rows)).not.toContain('pwd');
    await f.object.fetch(new Request('https://internal/invalidate', { method: 'POST' }));
  });
  it('blocks unauthorized servers, missing permissions, unsafe commands and missing fingerprints before dispatch', async () => {
    const f = fixture();
    expect((await f.call({ server_id: 99 })).status).toBe(403);
    f.principal.scopes = ['read'];
    f.principal.grants.forEach(grant => { grant.scopes = ['read']; });
    expect((await f.call()).status).toBe(403);
    f.principal.scopes = ['exec'];
    f.principal.grants.forEach(grant => { grant.scopes = ['exec']; });
    expect((await f.call({ command: 'rm -rf /' })).status).toBe(403);
    f.config.expectedFingerprint = undefined;
    const response = await f.call();
    expect(await response.json()).toMatchObject({ error: 'host_verification_required', status: 'not_executed' });
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it('does not follow Access redirects or disclose the upstream response', async () => {
    const f = fixture();
    f.fetchSpy.mockResolvedValue({ status: 302, body: 'SECRET-UPSTREAM-ERROR' } as never);
    const response = await f.call();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('SECRET-UPSTREAM');
    expect(SSHSession).not.toHaveBeenCalled();
  });
  it('rechecks revocation after authentication and releases the chain', async () => {
    const f = fixture();
    vi.mocked(SSHSession).mockImplementationOnce(class {
      startHandshake = async () => {}; waitUntilAuthenticated = async () => { f.revoke(); };
      close = vi.fn();
    } as never);
    const response = await f.call();
    expect(await response.json()).toMatchObject({ error: 'unauthorized', status: 'not_executed' });
  });
  it('rechecks a per-server permission reduction after authentication, before executing anything', async () => {
    const f = fixture(); const execute = vi.fn();
    vi.mocked(SSHSession).mockImplementationOnce(class {
      startHandshake = async () => {}; waitUntilAuthenticated = async () => { f.principal.grants = []; };
      close = vi.fn(); executeCommand = execute;
    } as never);
    expect(await (await f.call()).json()).toMatchObject({ error: 'unauthorized', status: 'not_executed' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('old cleanup cannot discard a replacement pool after a permission update', async () => {
    const f = fixture();
    const replacement = { busy: true, sessions: [], transports: [], lastUsed: Date.now(), expiresAt: Number.MAX_SAFE_INTEGER };
    vi.mocked(SSHSession).mockImplementationOnce(class {
      startHandshake = async () => {}; waitUntilAuthenticated = async () => {}; close = vi.fn();
      executeCommand = async () => { (f.object as any).connections.set(1, replacement); throw new Error('old operation failed'); };
    } as never);
    await f.call();
    expect((f.object as any).connections.get(1)).toBe(replacement);
    await f.object.fetch(new Request('https://internal/invalidate', { method: 'POST' }));
  });
  it('deleting one server aborts its active operation but leaves the other cached SSH session and alarm intact', async () => {
    const f = fixture();
    expect((await f.call({ server_id: 2 })).ok).toBe(true);
    const other = (f.object as any).connections.get(2);
    let started!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(SSHSession).mockImplementationOnce(class {
      startHandshake = async () => {}; waitUntilAuthenticated = async () => {}; close = vi.fn();
      executeCommand = async () => { started(); await pending; return {}; };
    } as never);
    const inFlight = f.call(); await ready;
    await f.object.fetch(new Request('https://internal/invalidate/1', { method: 'POST' }));
    expect(await (await inFlight).json()).toMatchObject({ status: 'unknown' }); release();
    expect((f.object as any).connections.has(1)).toBe(false);
    expect((f.object as any).connections.get(2)).toBe(other);
    expect(f.state.storage.deleteAlarm).not.toHaveBeenCalled();
    expect((await f.call({ server_id: 2 })).ok).toBe(true);
    expect(f.fetchSpy).toHaveBeenCalledTimes(2);
    await f.object.fetch(new Request('https://internal/invalidate/2', { method: 'POST' }));
    expect(f.state.storage.deleteAlarm).toHaveBeenCalledOnce();
  });
  it('rejects concurrent operations without queueing, cancels on disconnect and never replays commands', async () => {
    const f = fixture();
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    };
    const running = deferred();
    const started = deferred();
    const stop = vi.fn();
    vi.mocked(SSHSession).mockImplementationOnce(class {
      startHandshake = async () => {}; waitUntilAuthenticated = async () => {};
      isOperational = () => true; close = stop;
      executeCommand = async () => { started.resolve(); await running.promise; return { stdout: 'ok', stderr: '', exitCode: 0 }; };
    } as never);
    const controller = new AbortController();
    const first = f.call({}, controller.signal);
    await started.promise;
    expect((await f.call()).status).toBe(429);
    controller.abort();
    expect(await (await first).json()).toMatchObject({ status: 'unknown' });
    expect(stop).toHaveBeenCalled();
    expect(f.fetchSpy).toHaveBeenCalledOnce();
    running.resolve();
  });
  it('cleans idle connections through alarms and checks resolved tunnel addresses', async () => {
    const f = fixture();
    await f.call();
    const before = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(before + 61_000);
    await f.object.alarm();
    expect((f.object as any).connections.size).toBe(0);
    vi.restoreAllMocks();
    vi.mocked(checkHostResolved).mockResolvedValueOnce({ blocked: true, reason: 'private' });
    const response = await f.call();
    expect(response.status).toBe(409);
    expect(f.fetchSpy).toHaveBeenCalledOnce();
  });
});
