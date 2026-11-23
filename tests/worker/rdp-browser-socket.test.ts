import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const code = readFileSync(new URL('../../src/worker/rdp-client/rdp-socket.rdp-text', import.meta.url), 'utf8');
interface SocketAdapter {
  send(data: ArrayBuffer): void;
  consumed(bytes: number): void;
  readyState: number;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
}
function fixture() {
  const native = {
    protocol: 'cloudssh-rdp-v1',
    send: vi.fn(), close: vi.fn(),
    onopen: () => {}, onmessage: (_event: { data: unknown }) => {},
  };
  const browser = { setTimeout, createCloudSshRdpSocket: (_url: string, _token: string) => ({}) as SocketAdapter };
  class FakeWebSocket {
    constructor() { return native; }
  }
  runInNewContext(code, { window: browser, WebSocket: FakeWebSocket, Event, ArrayBuffer, Uint8Array, performance, clearTimeout });
  const socket = browser.createCloudSshRdpSocket('wss://example.com/api/rdp/session', 'token');
  return { native, socket };
}

describe('FreeRDP browser socket', () => {
  it('sends the ticket before open, keeps controls outside WASM, and acknowledges consumption only', async () => {
    vi.useFakeTimers();
    try {
      const { native, socket } = fixture();
      const onOpen = socket.onopen = vi.fn();
      const onData = socket.onmessage = vi.fn();
      native.onopen();
      expect(native.send).toHaveBeenLastCalledWith('{"type":"ticket","ticket":"token"}');
      expect(onOpen).not.toHaveBeenCalled();
      native.onmessage({ data: '{"type":"ready"}' });
      expect(onOpen).toHaveBeenCalledOnce();
      const incoming = new ArrayBuffer(12);
      native.onmessage({ data: incoming });
      expect(onData).toHaveBeenCalledExactlyOnceWith({ data: incoming });
      await vi.advanceTimersByTimeAsync(20);
      expect(native.send).toHaveBeenCalledOnce();
      socket.consumed(12);
      await vi.advanceTimersByTimeAsync(20);
      expect(native.send).toHaveBeenLastCalledWith('{"type":"ack","bytes":12}');
    } finally { vi.useRealTimers(); }
  });

  it('splits writes and rejects sending beyond the unacknowledged input window', () => {
    const { native, socket } = fixture();
    native.onmessage({ data: '{"type":"ready"}' });
    socket.send(new ArrayBuffer(1024 * 1024));
    expect(native.send).toHaveBeenCalledTimes(64);
    expect(native.send.mock.calls.every(([frame]) => frame.byteLength === 16 * 1024)).toBe(true);
    socket.send(new ArrayBuffer(1));
    expect(native.close).toHaveBeenCalledOnce();
  });
});
