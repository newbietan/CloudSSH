import { describe, expect, it, vi } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import { SSH_FXP_ATTRS, SSH_FXP_HANDLE } from '../../src/ssh/sftp-types';
import { SFTPHandler } from '../../src/worker/sftp-handler';

const MAX_BYTES = 500 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;

function createDownload(size: number, readBlock: (offset: number, length: number) => Uint8Array) {
  let sentBytes = 0;
  const sendJSON = vi.fn();
  const closeHandle = vi.fn(async () => {});
  const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON,
    (data) => { sentBytes += data.length; }, vi.fn());
  Object.assign(handler, {
    ready: true,
    sftp: {
      stat: vi.fn(async () => new Uint8Array([SSH_FXP_ATTRS])),
      parseAttrsResponse: () => ({ size }),
      openFile: vi.fn(async () => new Uint8Array([SSH_FXP_HANDLE])),
      parseHandleResponse: () => new Uint8Array([1]),
      closeHandle,
    },
    readBlock: vi.fn(async (_handle: Uint8Array, offset: number, length: number) => readBlock(offset, length)),
  });
  return { handler, sendJSON, closeHandle, sentBytes: () => sentBytes };
}

describe('SFTP download actual byte limits', () => {
  it('stops an unknown-size stream at the existing 500MiB limit and closes the handle', async () => {
    // Reuse one chunk: no 500MiB allocation and no real remote file or network traffic.
    const chunk = new Uint8Array(CHUNK_BYTES);
    const test = createDownload(0, (offset, length) =>
      offset <= MAX_BYTES ? chunk.subarray(0, length) : new Uint8Array());
    await test.handler.downloadFile('/proc/large-output');
    expect(test.sentBytes()).toBeLessThanOrEqual(MAX_BYTES);
    expect(test.sendJSON).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sftp_error', operation: 'download', message: expect.stringContaining('500'),
    }));
    expect(test.sendJSON).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sftp_download_done' }));
    expect(test.closeHandle).toHaveBeenCalledOnce();
  });

  it('allows exactly 500MiB when the unknown-size stream then reaches EOF', async () => {
    const chunk = new Uint8Array(CHUNK_BYTES);
    const test = createDownload(0, (offset, length) => offset < MAX_BYTES
      ? chunk.subarray(0, Math.min(length, MAX_BYTES - offset)) : new Uint8Array());
    await test.handler.downloadFile('/proc/finite-output');
    expect(test.sentBytes()).toBe(MAX_BYTES);
    expect(test.sendJSON).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sftp_download_done', size: MAX_BYTES,
    }));
    expect(test.closeHandle).toHaveBeenCalledOnce();
  });

  it.each([0, 17])('keeps ordinary empty and known-size downloads working (%s bytes)', async (size) => {
    const bytes = new Uint8Array(size);
    const test = createDownload(size, (offset, length) => bytes.subarray(offset, offset + length));
    await test.handler.downloadFile('/home/user/file');
    expect(test.sentBytes()).toBe(size);
    expect(test.sendJSON).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sftp_download_done', size,
    }));
    expect(test.closeHandle).toHaveBeenCalledOnce();
  });
});
