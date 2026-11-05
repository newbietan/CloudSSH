import { describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';

const encoder = new TextEncoder();

function createVersionSession(chunks: Uint8Array[]) {
  const read = vi.fn(async () => {
    const value = chunks.shift();
    return value ? { done: false, value } : { done: true, value: undefined };
  });
  const socket = { readable: { getReader: () => ({ read }) }, close: vi.fn() };
  const ws = { send: vi.fn(), close: vi.fn() };
  const session = new SSHSession(ws as unknown as WebSocket, socket, {
    host: 'ssh.example.com', port: 22, username: 'alice', authMethod: 'none', password: '',
  });
  const internal = session as any;
  internal.state = 'version';
  const startKEX = vi.spyOn(internal, 'startKEX').mockResolvedValue(undefined);
  const processPackets = vi.spyOn(internal, 'processPackets').mockResolvedValue(undefined);
  return { internal, read, socket, ws, startKEX, processPackets };
}

describe('SSH version exchange bounds', () => {
  it('rejects an unterminated banner before reading more data', async () => {
    const { internal, read, socket } = createVersionSession([new Uint8Array(65_537).fill(65)]);
    await internal.startReading();
    expect(read).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(internal.versionRawBuffer).toHaveLength(0);
  });

  it('bounds total preamble bytes even when every line is short and fully consumed', async () => {
    const banner = encoder.encode('notice\n'.repeat(5_000));
    const { internal, read, startKEX } = createVersionSession([banner, banner, banner]);
    await internal.startReading();
    expect(read).toHaveBeenCalledTimes(2);
    expect(startKEX).not.toHaveBeenCalled();
  });

  it('rejects an SSH identification line beyond the RFC 4253 255-byte limit', async () => {
    const { internal, read, startKEX } = createVersionSession([
      encoder.encode('SSH-2.0-' + 'x'.repeat(246) + '\r\n'),
    ]);
    await internal.startReading();
    expect(read).toHaveBeenCalledTimes(1);
    expect(startKEX).not.toHaveBeenCalled();
  });

  it('accepts split banners and a valid identification without counting following KEX bytes', async () => {
    const identification = encoder.encode('SSH-2.0-' + 'x'.repeat(245) + '\r\n');
    const tail = new Uint8Array(80_000).fill(7);
    const combined = new Uint8Array(identification.length - 5 + tail.length);
    combined.set(identification.subarray(5));
    combined.set(tail, identification.length - 5);
    const { internal, startKEX, processPackets } = createVersionSession([
      encoder.encode('Wel'), encoder.encode('come\r\n'), identification.subarray(0, 5), combined,
    ]);
    const feed = vi.spyOn(internal.packetParser, 'feed');
    await internal.startReading();
    expect(startKEX).toHaveBeenCalledOnce();
    expect(feed).toHaveBeenCalledWith(tail);
    expect(processPackets).toHaveBeenCalledOnce();
  });
});
