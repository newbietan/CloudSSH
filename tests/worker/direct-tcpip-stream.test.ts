import { describe, expect, it, vi } from 'vitest';
import { DirectTcpipStream } from '../../src/worker/direct-tcpip-stream';

describe('DirectTcpipStream', () => {
  it.each(['eof', 'close'] as const)('drains pending data before remote %s', async (end) => {
    const onRead = vi.fn();
    const stream = new DirectTcpipStream(vi.fn(async () => {}), vi.fn(async () => {}), onRead);
    stream.push(new Uint8Array([1]));
    stream.push(new Uint8Array([2, 3]));
    stream.push(new Uint8Array([4]));
    if (end === 'eof') stream.remoteEof();
    else stream.remoteClose();
    stream.push(new Uint8Array([99]));

    const reader = stream.readable.getReader();
    const received: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received.push(...value!);
    }
    expect(received).toEqual([1, 2, 3, 4]);
    expect(onRead).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it('discards pending data immediately on a remote error', async () => {
    const stream = new DirectTcpipStream(vi.fn(async () => {}), vi.fn(async () => {}), vi.fn());
    stream.push(new Uint8Array([1]));
    stream.push(new Uint8Array([2]));
    stream.remoteClose(new Error('link failed'));
    await expect(stream.readable.getReader().read()).rejects.toThrow('link failed');
  });

  it('cancels pending reads after a normal remote close without closing the channel twice', async () => {
    const close = vi.fn(async () => {});
    const stream = new DirectTcpipStream(vi.fn(async () => {}), close, vi.fn());
    stream.push(new Uint8Array([1]));
    stream.push(new Uint8Array([2]));
    stream.remoteClose();
    await stream.readable.cancel();
    expect((stream as any).pendingReads).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
  });

  it('在嵌套消费者拉取后补充接收窗口，并双向转发数据', async () => {
    const write = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const onRead = vi.fn();
    const stream = new DirectTcpipStream(write, close, onRead);
    const reader = stream.readable.getReader();

    stream.push(new Uint8Array([1, 2]));
    stream.push(new Uint8Array([3, 4, 5]));
    expect(onRead).toHaveBeenCalledTimes(1);

    expect(Array.from((await reader.read()).value || [])).toEqual([1, 2]);
    expect(Array.from((await reader.read()).value || [])).toEqual([3, 4, 5]);
    expect(onRead).toHaveBeenNthCalledWith(1, 2);
    expect(onRead).toHaveBeenNthCalledWith(2, 3);

    const writer = stream.writable.getWriter();
    await writer.write(new Uint8Array([9]));
    expect(write).toHaveBeenCalledOnce();

    stream.remoteEof();
    expect((await reader.read()).done).toBe(true);
    stream.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
