import { describe, expect, it } from 'vitest';
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
