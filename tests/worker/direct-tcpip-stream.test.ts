import { describe, expect, it, vi } from 'vitest';
import { DirectTcpipStream } from '../../src/worker/direct-tcpip-stream';

describe('DirectTcpipStream', () => {
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
