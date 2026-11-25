import { expect, it, vi } from 'vitest';
import { RdpDirectDnsError } from '../../src/worker/rdp-direct-dns';
import { startRdpRelay } from '../../src/worker/rdp-relay';
import { openRdpTransport } from '../../src/worker/rdp-transport';

vi.mock('../../src/worker/rdp-transport', () => ({ openRdpTransport: vi.fn() }));

it('rate-limits relay pong without entering the RDP transport or extending user idle time', async () => {
  vi.useFakeTimers();
  try {
    const ws = Object.assign(new EventTarget(), { accept: vi.fn(), send: vi.fn(), close: vi.fn() });
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = ws; });
    vi.stubGlobal('Response', class {}); // Node Response rejects Cloudflare's 101 init.
    const write = vi.fn();
    vi.mocked(openRdpTransport).mockResolvedValue({ read: () => new Promise(() => {}), write, close: vi.fn() });
    const lease = '12345678-1234-1234-1234-123456789abc';
    const release = vi.fn(async () => {});
    const desktopReady = vi.fn(async () => true);
    startRdpRelay({ desktopReady, idleMs: 2000, renew: async () => true, release, claim: async () => ({ id: lease,
      profile: { id: lease, revision: 1, name: 'test', host: '8.8.8.8', route: 'direct', hasLogin: true, hasAccessToken: false, tags: [], fingerprint: null },
    }) });
    const send = (data: object) => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    send({ type: 'ticket', ticket: 'a'.repeat(64) });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'ready', lease, desktopReport: true }));
    send({ type: 'ping', id: 1 }); send({ type: 'ping', id: 2 });
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenLastCalledWith('{"type":"pong","id":1}');
    await vi.advanceTimersByTimeAsync(1500);
    send({ type: 'ping', id: 3 });
    expect(ws.send).toHaveBeenLastCalledWith('{"type":"pong","id":3}');
    expect(desktopReady).not.toHaveBeenCalled();
    send({ type: 'desktop_ready' }); send({ type: 'desktop_ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(desktopReady).toHaveBeenCalledExactlyOnceWith(lease);
    expect(ws.send).toHaveBeenLastCalledWith('{"type":"desktop_recorded"}');
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.close).toHaveBeenCalledWith(1000, 'idle_timeout');
    expect(write).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(lease);
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it.each([
  [new RdpDirectDnsError('direct_dns_failed'), 'direct_dns_failed'],
  [new RdpDirectDnsError('direct_dns_blocked'), 'direct_dns_blocked'],
  [new Error('do not expose upstream diagnostic'), 'upstream_unavailable'],
] as const)('releases a failed lease and exposes only the fixed relay reason %s', async (error, reason) => {
  vi.useFakeTimers();
  try {
    const ws = Object.assign(new EventTarget(), { accept: vi.fn(), send: vi.fn(), close: vi.fn() });
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = ws; });
    vi.stubGlobal('Response', class {});
    vi.mocked(openRdpTransport).mockRejectedValueOnce(error);
    const lease = '12345678-1234-1234-1234-123456789abc';
    const release = vi.fn(async () => {});
    const renew = vi.fn(async () => true);
    startRdpRelay({ desktopReady: async () => true, idleMs: 0, renew, release, claim: async () => ({ id: lease,
      profile: { id: lease, revision: 1, name: 'test', host: 'rdp.example.com', port: 3389, route: 'direct',
        hasLogin: true, hasAccessToken: false, tags: [], fingerprint: null },
    }) });
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ticket', ticket: 'a'.repeat(64) }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1011, reason);
    expect(ws.send).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(lease);
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it('keeps the lease and socket alive on upstream EOF during first-time cert confirmation until cert_done', async () => {
  vi.useFakeTimers();
  try {
    const ws = Object.assign(new EventTarget(), { accept: vi.fn(), send: vi.fn(), close: vi.fn() });
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = ws; });
    vi.stubGlobal('Response', class {});
    let finishRead!: () => void;
    const closeTransport = vi.fn();
    vi.mocked(openRdpTransport).mockResolvedValue({
      read: async (deliver) => {
        await deliver(new Uint8Array(32));
        await new Promise<void>(resolve => { finishRead = resolve; });
      },
      write: vi.fn(),
      close: closeTransport,
    });
    const lease = '12345678-1234-1234-1234-123456789abc';
    const release = vi.fn(async () => {});
    const renew = vi.fn(async () => true);
    startRdpRelay({
      desktopReady: async () => true, idleMs: 2000, renew, release,
      claim: async () => ({
        id: lease,
        profile: { id: lease, revision: 1, name: 'test', host: 'rdp.example.com', port: 53389, route: 'direct',
          hasLogin: true, hasAccessToken: false, tags: [], fingerprint: null },
      }),
    });
    const send = (data: object) => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    send({ type: 'ticket', ticket: 'a'.repeat(64) });
    await vi.advanceTimersByTimeAsync(0);
    send({ type: 'cert_wait' });
    // Even if unacked TLS bytes sit for >30s and idleMs is 2s, cert_wait pauses idle/slow_connection.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalledTimes(3); // initial + 15s + 30s
    finishRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(closeTransport).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenLastCalledWith('{"type":"cert_hold"}');
    expect(ws.close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    send({ type: 'cert_done' });
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, 'cert_reconnect');
    expect(release).toHaveBeenCalledExactlyOnceWith(lease);
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it('handles the race where upstream closes right after sending TLS bytes before cert_wait arrives, and bounds hold to 90s', async () => {
  vi.useFakeTimers();
  try {
    const ws = Object.assign(new EventTarget(), { accept: vi.fn(), send: vi.fn(), close: vi.fn() });
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = ws; });
    vi.stubGlobal('Response', class {});
    vi.mocked(openRdpTransport).mockResolvedValue({
      read: async (deliver) => { await deliver(new Uint8Array(32)); },
      write: vi.fn(),
      close: vi.fn(),
    });
    const lease = '12345678-1234-1234-1234-123456789abc';
    const release = vi.fn(async () => {});
    startRdpRelay({
      desktopReady: async () => true, idleMs: 0, renew: async () => true, release,
      claim: async () => ({
        id: lease,
        profile: { id: lease, revision: 1, name: 'test', host: 'rdp.example.com', port: 53389, route: 'direct',
          hasLogin: true, hasAccessToken: false, tags: [], fingerprint: null },
      }),
    });
    const send = (data: object) => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    send({ type: 'ticket', ticket: 'a'.repeat(64) });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.send).toHaveBeenLastCalledWith('{"type":"cert_hold"}');
    expect(ws.close).not.toHaveBeenCalled();
    send({ type: 'cert_wait' });
    await vi.advanceTimersByTimeAsync(89_000);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, 'cert_timeout');
    expect(release).toHaveBeenCalledExactlyOnceWith(lease);
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it('closes immediately with session_ended on upstream EOF when certificate fingerprint is already trusted', async () => {
  vi.useFakeTimers();
  try {
    const ws = Object.assign(new EventTarget(), { accept: vi.fn(), send: vi.fn(), close: vi.fn() });
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = ws; });
    vi.stubGlobal('Response', class {});
    vi.mocked(openRdpTransport).mockResolvedValue({
      read: async (deliver) => { await deliver(new Uint8Array(32)); },
      write: vi.fn(),
      close: vi.fn(),
    });
    const lease = '12345678-1234-1234-1234-123456789abc';
    const release = vi.fn(async () => {});
    startRdpRelay({
      desktopReady: async () => true, idleMs: 0, renew: async () => true, release,
      claim: async () => ({
        id: lease,
        profile: { id: lease, revision: 1, name: 'test', host: 'rdp.example.com', port: 53389, route: 'direct',
          hasLogin: true, hasAccessToken: false, tags: [], fingerprint: 'ab'.repeat(32) },
      }),
    });
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'ticket', ticket: 'a'.repeat(64) }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1000, 'session_ended');
    expect(release).toHaveBeenCalledExactlyOnceWith(lease);
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});
