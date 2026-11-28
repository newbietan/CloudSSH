import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RDP_WINDOW } from '../../src/rdp-schema';
import { startRdpRelay } from '../../src/worker/rdp-relay';
import { openRdpTransport, type RdpTransport } from '../../src/worker/rdp-transport';

vi.mock('../../src/worker/rdp-transport', () => ({ openRdpTransport: vi.fn() }));
const lease = '12345678-1234-1234-1234-123456789abc';
let disconnect: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  disconnect?.(); disconnect = undefined;
  vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers();
});

// Memory-only ordered byte stream, not an RDP/NTLM peer. No real TCP or Windows credentials.
async function relay({ route = 'direct', optIn = true, idleMs = 0, write = async () => {} }: {
  route?: 'direct' | 'tunnel'; optIn?: boolean; idleMs?: number; write?: RdpTransport['write'];
} = {}) {
  const ws = Object.assign(new EventTarget(), { accept: vi.fn(), send: vi.fn(), close: vi.fn() });
  vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = ws; });
  vi.stubGlobal('Response', class {});
  let deliver!: Parameters<RdpTransport['read']>[0], endRead!: () => void;
  const tcpWrite = vi.fn(write);
  vi.mocked(openRdpTransport).mockResolvedValueOnce({
    read: fn => { deliver = fn; return new Promise(resolve => { endRead = resolve; }); },
    write: tcpWrite, close: () => endRead?.(),
  });
  const renew = vi.fn(async () => true);
  startRdpRelay({ renew, idleMs, desktopReady: async () => true, release: async () => {},
    claim: async () => ({ id: lease, profile: { id: lease, name: 'fixture', host: 'fixture.invalid',
      route, tags: [], revision: 1, fingerprint: 'ab'.repeat(32), hasLogin: true, hasAccessToken: false } }),
  });
  const send = (data: string | ArrayBuffer) => ws.dispatchEvent(new MessageEvent('message', { data }));
  const ctl = (msg: object) => send(JSON.stringify(msg));
  const controls = () => ws.send.mock.calls.flatMap(([m]) => typeof m === 'string' ? [JSON.parse(m)] : []);
  const samples = () => controls().filter(m => m.type === 'binding_return');
  disconnect = () => ws.dispatchEvent(new Event('close'));
  ctl({ type: 'ticket', ticket: 'a'.repeat(64), bindingReturn: optIn });
  await vi.advanceTimersByTimeAsync(0);
  expect(controls()[0].bindingReturn).toBe(optIn && route === 'direct' ? true : undefined);
  return { input: (bytes: number) => send(new ArrayBuffer(bytes)), read: (bytes: number) => deliver(new Uint8Array(bytes)),
    watch: (bytes: number) => ctl({ type: 'binding_watch', bytes }), ctl, samples, tcpWrite, renew, ws };
}

it('samples only a matching write on normal renewals; old payload and controls do not count or extend idle', async () => {
  const r = await relay({ idleMs: 16_000 });
  r.input(5); await vi.advanceTimersByTimeAsync(0); await r.read(8);
  r.ctl({ type: 'ack', bytes: 8 }); r.input(16);
  r.watch(5); r.watch(500); r.watch(21); r.watch(21);
  await vi.advanceTimersByTimeAsync(0); await r.read(0);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(r.samples()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(r.samples()).toEqual([{ type: 'binding_return', bytes: 21, state: 'no_read', seconds: 15 }]);
  expect(r.renew).toHaveBeenCalledTimes(2); // Establish + existing 15 second renewal; no extra request.
  expect(r.tcpWrite.mock.calls.map(([value]) => value.length)).toEqual([5, 16]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(r.ws.close).toHaveBeenCalledWith(1000, 'idle_timeout');
});

it('retains a fast return before the watch or write ACK, but does not report until the write completes', async () => {
  let finishWrite!: () => void;
  const r = await relay({ write: () => new Promise(resolve => { finishWrite = resolve; }) });
  r.input(9); await vi.advanceTimersByTimeAsync(0);
  await r.read(7); r.ctl({ type: 'ack', bytes: 7 }); r.watch(9);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(r.samples()).toEqual([]);
  finishWrite(); await vi.advanceTimersByTimeAsync(15_000);
  expect(r.samples()).toEqual([{ type: 'binding_return', bytes: 9, state: 'forwarded', seconds: 30 }]);
});

it.each(['before', 'after'] as const)('does not retag a read made %s the binding write while it waits for return credit', async when => {
  const r = await relay();
  await r.read(RDP_WINDOW);
  const old = when === 'before' ? r.read(17) : undefined; // Held behind 1 MiB of earlier output.
  r.input(11); await vi.advanceTimersByTimeAsync(0); r.watch(11);
  const pending = old ?? r.read(17);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(r.samples().at(-1)?.state).toBe(old ? 'prior_window' : 'read_window');
  r.ctl({ type: 'ack', bytes: RDP_WINDOW }); await pending;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(r.samples().at(-1)?.state).toBe(old ? 'no_read' : 'forwarded');
});

it.each(['tunnel', 'old client', 'no watch', 'first frame', 'unmatched'] as const)('sends no return samples for %s', async mode => {
  const r = await relay({ route: mode === 'tunnel' ? 'tunnel' : 'direct', optIn: mode !== 'old client' });
  r.input(4);
  if (mode !== 'no watch') r.watch(mode === 'unmatched' ? 9 : 4);
  if (mode === 'first frame') r.ctl({ type: 'desktop_ready' });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(r.samples()).toEqual([]); expect(r.tcpWrite).toHaveBeenCalledTimes(1);
});

it.each(['lease rejected', 'ended during renewal'] as const)('does not publish a sample when %s', async mode => {
  const r = await relay();
  r.input(4); r.watch(4);
  let settle!: (ok: boolean) => void;
  r.renew.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  await vi.advanceTimersByTimeAsync(15_000);
  if (mode === 'ended during renewal') disconnect!();
  settle(mode === 'ended during renewal'); await vi.advanceTimersByTimeAsync(0);
  expect(r.samples()).toEqual([]);
  expect(r.ws.close).toHaveBeenCalledTimes(1);
});

it('a replay cannot rearm a completed four-sample watch or reset its timestamp', async () => {
  const r = await relay(); r.input(4); r.watch(4);
  await vi.advanceTimersByTimeAsync(21_000); r.watch(4);
  await vi.advanceTimersByTimeAsync(44_000); r.watch(4);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(r.samples().map(({ seconds }) => seconds)).toEqual([15, 30, 45, 60]);
});
