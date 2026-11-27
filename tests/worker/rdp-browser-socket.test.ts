import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const code = readFileSync(new URL('../../src/worker/rdp-client/rdp-socket.rdp-text', import.meta.url), 'utf8');
interface SocketAdapter {
  send(data: ArrayBuffer): void;
  consumed(bytes: number): void;
  readyState: number;
  lease?: string;
  certHold: boolean;
  beginCertWait(): void;
  endCertWait(): void;
  reportDesktopReady(): void;
  onRelayClose?: (reason: string) => void;
  onclose?: (event: { reason: string }) => void;
  onDesktopRecorded?: () => void;
  probe(): void;
  cancelProbe(): void;
  takeReceiveBacklog(): number | undefined;
  onRelayRtt?: (ms: number) => void;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
}
const lease = '12345678-1234-1234-1234-123456789abc';
const ready = JSON.stringify({ type: 'ready', lease });
function fixture(clock = performance, direct = false) {
  const native = {
    protocol: 'cloudssh-rdp-v1',
    send: vi.fn(), close: vi.fn(),
    onclose: (_event: { reason: string }) => {},
    onopen: () => {}, onmessage: (_event: { data: unknown }) => {},
  };
  const browser = { setTimeout, createCloudSshRdpSocket: (_url: string, _token: string, _carrier?: typeof native) => ({}) as SocketAdapter };
  class FakeWebSocket {
    constructor() { return native; }
  }
  runInNewContext(code, { window: browser, WebSocket: FakeWebSocket, Event, ArrayBuffer, Uint8Array, performance: clock, clearTimeout });
  const socket = browser.createCloudSshRdpSocket('wss://example.com/api/rdp/session', 'token', direct ? native : undefined);
  return { native, socket };
}

describe('FreeRDP browser socket', () => {
  it('reports the close reason before the generic runtime close callback', () => {
    const { native, socket } = fixture();
    const observed: string[] = [];
    socket.onRelayClose = reason => observed.push(reason);
    socket.onclose = () => observed.push('closed');
    native.onclose({ reason: 'idle_timeout' });
    expect(observed).toEqual(['idle_timeout', 'closed']);
    expect(socket.readyState).toBe(3);
  });

  it('sends the ticket before open, keeps controls outside WASM, and acknowledges consumption only', async () => {
    vi.useFakeTimers();
    try {
      const { native, socket } = fixture();
      const onOpen = socket.onopen = vi.fn();
      const onData = socket.onmessage = vi.fn();
      native.onopen();
      expect(native.send).toHaveBeenLastCalledWith('{"type":"ticket","ticket":"token"}');
      expect(onOpen).not.toHaveBeenCalled();
      native.onmessage({ data: ready });
      expect(onOpen).toHaveBeenCalledOnce();
      expect(socket.lease).toBe(lease);
      const incoming = new ArrayBuffer(12);
      native.onmessage({ data: incoming });
      expect(onData).toHaveBeenCalledExactlyOnceWith({ data: incoming });
      await vi.advanceTimersByTimeAsync(20);
      expect(native.send).toHaveBeenCalledOnce();
      socket.consumed(12);
      await vi.advanceTimersByTimeAsync(15);
      expect(native.send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(native.send).toHaveBeenLastCalledWith('{"type":"ack","bytes":12}');
    } finally { vi.useRealTimers(); }
  });

  it('releases direct read credit after 8 ms or 64 KiB without duplicate or delivery-only ACKs', async () => {
    vi.useFakeTimers();
    try {
      const { native, socket } = fixture(performance, true);
      native.onmessage({ data: ready });
      for (let i = 0; i < 5; i++) native.onmessage({ data: new ArrayBuffer(16 * 1024) });
      await vi.advanceTimersByTimeAsync(20);
      expect(native.send).not.toHaveBeenCalled();
      socket.consumed(1200);
      await vi.advanceTimersByTimeAsync(7);
      expect(native.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(native.send).toHaveBeenCalledExactlyOnceWith('{"type":"ack","bytes":1200}');
      socket.consumed(8 * 1024);
      expect(native.send).toHaveBeenCalledTimes(1);
      socket.consumed(56 * 1024);
      expect(native.send).toHaveBeenLastCalledWith('{"type":"ack","bytes":66736}');
      socket.consumed(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(native.send).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('samples the receive high-water mark without changing read credit', async () => {
    vi.useFakeTimers();
    try {
      const { native, socket } = fixture();
      expect(socket.takeReceiveBacklog()).toBeUndefined();
      native.onmessage({ data: ready });
      expect(socket.takeReceiveBacklog()).toBe(0);
      native.onmessage({ data: new ArrayBuffer(16 * 1024) });
      native.onmessage({ data: new ArrayBuffer(16 * 1024) });
      socket.consumed(24 * 1024);
      expect(socket.takeReceiveBacklog()).toBe(32 * 1024);
      expect(socket.takeReceiveBacklog()).toBe(8 * 1024); // Still queued at the next interval's start.
      socket.consumed(8 * 1024);
      expect(socket.takeReceiveBacklog()).toBe(8 * 1024);
      expect(socket.takeReceiveBacklog()).toBe(0);
      expect(native.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(native.send).toHaveBeenCalledExactlyOnceWith('{"type":"ack","bytes":32768}');
      native.onclose({ reason: 'closed' });
      expect(socket.takeReceiveBacklog()).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('reports first paint only once and only if the relay negotiated support', () => {
    const old = fixture();
    old.native.onmessage({ data: ready });
    old.socket.reportDesktopReady();
    expect(old.native.send).not.toHaveBeenCalled();
    const { native, socket } = fixture();
    native.onmessage({ data: JSON.stringify({ type: 'ready', lease, desktopReport: true }) });
    socket.reportDesktopReady(); socket.reportDesktopReady();
    expect(native.send).toHaveBeenCalledExactlyOnceWith('{"type":"desktop_ready"}');
    const recorded = socket.onDesktopRecorded = vi.fn();
    native.onmessage({ data: '{"type":"desktop_recorded"}' });
    expect(recorded).toHaveBeenCalledOnce();
  });

  it('times one matched relay pong locally and ignores stale, duplicate, expired and cancelled responses', () => {
    let now = 100;
    const { native, socket } = fixture({ now: () => now } as Performance);
    const sample = socket.onRelayRtt = vi.fn();
    const pong = (id: number) => native.onmessage({ data: JSON.stringify({ type: 'pong', id }) });
    socket.probe();
    expect(native.send).not.toHaveBeenCalled();
    native.onmessage({ data: ready });
    socket.probe(); socket.probe();
    expect(native.send).toHaveBeenCalledExactlyOnceWith('{"type":"ping","id":1}');
    now += 27; pong(99); pong(1); pong(1);
    expect(sample).toHaveBeenCalledExactlyOnceWith(27);
    socket.probe(); now += 5100; pong(2);
    socket.probe(); socket.cancelProbe(); pong(3);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('splits writes and rejects sending beyond the unacknowledged input window', () => {
    const { native, socket } = fixture();
    native.onmessage({ data: ready });
    socket.send(new ArrayBuffer(1024 * 1024));
    expect(native.send).toHaveBeenCalledTimes(64);
    expect(native.send.mock.calls.every(([frame]) => frame.byteLength === 16 * 1024)).toBe(true);
    socket.send(new ArrayBuffer(1));
    expect(native.close).toHaveBeenCalledOnce();
  });

  it('keeps certificate hold and completion outside the WASM stream', () => {
    const { native, socket } = fixture();
    const onData = socket.onmessage = vi.fn();
    native.onmessage({ data: ready });
    socket.beginCertWait();
    socket.beginCertWait();
    expect(native.send).toHaveBeenCalledExactlyOnceWith('{"type":"cert_wait"}');
    native.onmessage({ data: '{"type":"cert_hold"}' });
    expect(socket.certHold).toBe(true);
    expect(onData).not.toHaveBeenCalled();
    socket.endCertWait();
    expect(native.send).toHaveBeenLastCalledWith('{"type":"cert_done"}');
  });
});
