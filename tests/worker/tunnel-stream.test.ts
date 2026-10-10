import { describe, expect, it, vi } from 'vitest';
import { SSHAESCTRCipher, SSHAESGCMCipher, SSHHMAC } from '../../src/ssh/crypto';
import { SSHPacketBuilder } from '../../src/ssh/packet';
import { isValidTunnelHostname, TunnelWebSocketStream } from '../../src/worker/tunnel-stream';

class FakeWebSocket {
  listeners: Record<string, ((event: any) => void)[]> = {};
  binaryType = 'blob';
  sentData: any[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];

  addEventListener(event: string, cb: (event: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }

  removeEventListener(event: string, cb: (event: any) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((l) => l !== cb);
  }

  send(data: any) {
    this.sentData.push(data);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
  }

  emitMessage(data: any) {
    const handlers = this.listeners['message'] || [];
    for (const h of handlers) h({ data });
  }

  emitClose() {
    const handlers = this.listeners['close'] || [];
    for (const h of handlers) h({});
  }

  emitError(error?: any) {
    const handlers = this.listeners['error'] || [];
    for (const h of handlers) h(error || {});
  }
}

// cloudflared 2026.9.3: Conn.Read reads an entire WebSocket message, then
// copy(reader, data) discards anything beyond stream.Pipe's 16KiB buffer.
class CloudflaredPipeWebSocket extends FakeWebSocket {
  received: Uint8Array[] = [];

  override send(data: Uint8Array): void {
    super.send(data);
    this.received.push(data.slice(0, 16 * 1024));
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function patternedBytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) & 0xff);
}

describe('TunnelWebSocketStream', () => {
  it('设置 binaryType 为 arraybuffer 并将接收的二进制数据泵入 readable', async () => {
    const ws = new FakeWebSocket();
    const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
    expect(ws.binaryType).toBe('arraybuffer');
    await expect(stream.opened).resolves.toBeUndefined();

    const reader = stream.readable.getReader();

    // 1. ArrayBuffer 数据
    const buf = new Uint8Array([1, 2, 3]).buffer;
    ws.emitMessage(buf);
    const read1 = await reader.read();
    expect(read1.done).toBe(false);
    expect(Array.from(read1.value!)).toEqual([1, 2, 3]);

    // 2. Uint8Array 视图数据
    const view = new Uint8Array([4, 5, 6]);
    ws.emitMessage(view);
    const read2 = await reader.read();
    expect(read2.done).toBe(false);
    expect(Array.from(read2.value!)).toEqual([4, 5, 6]);

    // 3. 字符串数据
    ws.emitMessage('hello');
    const read3 = await reader.read();
    expect(read3.done).toBe(false);
    expect(new TextDecoder().decode(read3.value)).toBe('hello');

    // 4. WebSocket 关闭
    ws.emitClose();
    const read4 = await reader.read();
    expect(read4.done).toBe(true);
  });

  it('将 writable 的数据通过 ws.send 发送', async () => {
    const ws = new FakeWebSocket();
    const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);

    const writer = stream.writable.getWriter();
    await writer.write(new Uint8Array([10, 20, 30]));
    expect(ws.sentData).toHaveLength(1);
    expect(Array.from(ws.sentData[0])).toEqual([10, 20, 30]);

    await writer.close();
    expect(ws.closeCalls).toHaveLength(1);
    expect(ws.closeCalls[0].code).toBe(1000);
  });

  it.each([10 * 1024, 16383, 16384, 16385, 64 * 1024, 128 * 1024])(
    '写入 %i 字节经过 cloudflared 16KiB 读取边界后不丢字节',
    async (size) => {
      const ws = new CloudflaredPipeWebSocket();
      const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
      const writer = stream.writable.getWriter();
      // Include a nonzero byteOffset so framing cannot accidentally send the backing buffer.
      const backing = patternedBytes(size + 37);
      const input = backing.subarray(19, 19 + size);

      await writer.write(input);

      expect(ws.sentData.every((frame: Uint8Array) => frame.length <= 16 * 1024)).toBe(true);
      expect(concatBytes(ws.received)).toEqual(input);
      await writer.close();
    }
  );

  it.each(['ctr', 'gcm'] as const)(
    '16KiB SSH 载荷加上 %s 加密开销后仍可穿过 cloudflared 并验证完整性',
    async (mode) => {
      const key = new Uint8Array(16).fill(3);
      const iv = new Uint8Array(mode === 'ctr' ? 16 : 12).fill(5);
      const encryptCipher =
        mode === 'ctr' ? new SSHAESCTRCipher(key, iv) : new SSHAESGCMCipher(key, iv);
      const decryptCipher =
        mode === 'ctr' ? new SSHAESCTRCipher(key, iv) : new SSHAESGCMCipher(key, iv);
      const mac = new SSHHMAC('hmac-sha2-256', new Uint8Array(32).fill(9));
      await Promise.all([encryptCipher.init(), decryptCipher.init(), mac.init()]);
      const payload = patternedBytes(9 + 16 * 1024);
      payload[0] = 94; // SSH_MSG_CHANNEL_DATA: channel header + 16KiB data.
      const packet = await SSHPacketBuilder.build(
        payload,
        16,
        (data, seq, aad) => encryptCipher.encrypt(data, seq, aad),
        0,
        mode === 'gcm',
        mode === 'ctr' ? (data, seq) => mac.sign(data, seq) : undefined
      );
      expect(packet.length).toBeGreaterThan(16 * 1024);
      // This is the old adapter's failure: one message loses its encrypted tail.
      expect(packet.slice(0, 16 * 1024).length).toBeLessThan(packet.length);

      const ws = new CloudflaredPipeWebSocket();
      const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
      const writer = stream.writable.getWriter();
      await writer.write(packet);
      const received = concatBytes(ws.received);
      expect(received).toEqual(packet);

      const plaintext =
        mode === 'ctr'
          ? await decryptCipher.decrypt(received.subarray(0, received.length - mac.length), 0)
          : await decryptCipher.decrypt(received.subarray(4), 0, received.subarray(0, 4));
      expect(plaintext).not.toBeNull();
      if (mode === 'ctr') {
        expect(
          await mac.verify(plaintext!, 0, received.subarray(received.length - mac.length))
        ).toBe(true);
      }
      const payloadOffset = mode === 'ctr' ? 5 : 1;
      expect(plaintext!.subarray(payloadOffset, payloadOffset + payload.length)).toEqual(payload);
      await writer.close();
    }
  );

  it('连续排队的大包保持原始字节顺序，不混入其他写入', async () => {
    const ws = new CloudflaredPipeWebSocket();
    const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
    const writer = stream.writable.getWriter();
    const inputs = [patternedBytes(32797), new Uint8Array(32797).fill(0xa5), patternedBytes(38)];

    await Promise.all(inputs.map((input) => writer.write(input)));

    expect(concatBytes(ws.received)).toEqual(concatBytes(inputs));
    expect(ws.sentData.every((frame: Uint8Array) => frame.length <= 16 * 1024)).toBe(true);
    await writer.close();
  });

  it('帧间等待时关闭连接，不继续发送剩余分帧', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    try {
      const ws = new CloudflaredPipeWebSocket();
      const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
      const writer = stream.writable.getWriter();
      const writing = writer.write(patternedBytes(64 * 1024));
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.sentData).toHaveLength(1);

      ws.emitClose();
      const rejected = expect(writing).rejects.toThrow('Tunnel WebSocket is closed');
      await vi.advanceTimersByTimeAsync(2);
      await rejected;
      expect(ws.sentData).toHaveLength(1);
      writer.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it('中间分帧发送失败时传播错误并停止发送尾片', async () => {
    const ws = new CloudflaredPipeWebSocket();
    vi.spyOn(ws, 'send').mockImplementation((data: Uint8Array) => {
      if (ws.sentData.length === 1) throw new Error('send failed');
      ws.sentData.push(data);
    });
    const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
    const reader = stream.readable.getReader();
    const readRejected = expect(reader.read()).rejects.toThrow('send failed');
    const writer = stream.writable.getWriter();

    await expect(writer.write(patternedBytes(64 * 1024))).rejects.toThrow('send failed');
    await readRejected;
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.sentData).toHaveLength(1);
    expect(ws.closeCalls).toHaveLength(1);
    expect(ws.listeners['message']).toHaveLength(0);
    writer.releaseLock();
    reader.releaseLock();
  });

  it('空写入不生成载体消息，后续正常写入不受影响', async () => {
    const ws = new FakeWebSocket();
    const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
    const writer = stream.writable.getWriter();

    await writer.write(new Uint8Array());
    expect(ws.sentData).toHaveLength(0);
    await writer.write(new Uint8Array([42]));
    expect(ws.sentData).toHaveLength(1);
    expect(Array.from(ws.sentData[0])).toEqual([42]);
    await writer.close();
  });

  it('WebSocket 错误会向 reader 传播异常', async () => {
    const ws = new FakeWebSocket();
    const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);
    const reader = stream.readable.getReader();

    ws.emitError(new Error('Network error'));
    await expect(reader.read()).rejects.toThrow('Tunnel WebSocket connection error');
  });

  it('主动调用 close 会正常关闭 WebSocket 并解绑所有事件监听器', () => {
    const ws = new FakeWebSocket();
    const stream = new TunnelWebSocketStream(ws as unknown as WebSocket);

    expect(ws.listeners['message']?.length).toBe(1);
    expect(ws.listeners['close']?.length).toBe(1);
    expect(ws.listeners['error']?.length).toBe(1);

    stream.close();
    expect(ws.closeCalls).toHaveLength(1);
    expect(ws.closeCalls[0].code).toBe(1000);

    expect(ws.listeners['message']?.length).toBe(0);
    expect(ws.listeners['close']?.length).toBe(0);
    expect(ws.listeners['error']?.length).toBe(0);
  });
});

describe('isValidTunnelHostname', () => {
  it('合法的多级域名返回 true', () => {
    expect(isValidTunnelHostname('ssh.example.com')).toBe(true);
    expect(isValidTunnelHostname('tunnel-1.sub.my-domain.org')).toBe(true);
    expect(isValidTunnelHostname('a.b.co')).toBe(true);
    expect(isValidTunnelHostname('dev.internal.corp.net')).toBe(true);
  });

  it('IPv4 / IPv6 字面量返回 false', () => {
    expect(isValidTunnelHostname('192.168.1.1')).toBe(false);
    expect(isValidTunnelHostname('1.1.1.1')).toBe(false);
    expect(isValidTunnelHostname('10.0.0.1')).toBe(false);
    expect(isValidTunnelHostname('::1')).toBe(false);
    expect(isValidTunnelHostname('2001:db8::1')).toBe(false);
  });

  it('无点单级主机名返回 false', () => {
    expect(isValidTunnelHostname('localhost')).toBe(false);
    expect(isValidTunnelHostname('myserver')).toBe(false);
    expect(isValidTunnelHostname('')).toBe(false);
  });

  it('包含非法字符、空格或格式错误的域名返回 false', () => {
    expect(isValidTunnelHostname('ssh.example.com:22')).toBe(false);
    expect(isValidTunnelHostname('ssh example.com')).toBe(false);
    expect(isValidTunnelHostname('ssh/example.com')).toBe(false);
    expect(isValidTunnelHostname('.ssh.example.com')).toBe(false);
    expect(isValidTunnelHostname('ssh.example.com.')).toBe(false);
    expect(isValidTunnelHostname('-ssh.example.com')).toBe(false);
    expect(isValidTunnelHostname('ssh-.example.com')).toBe(false);
    expect(isValidTunnelHostname('ssh..example.com')).toBe(false);
  });
});
