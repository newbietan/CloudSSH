import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SFTPClient } from '../../src/ssh/sftp';
import { mcpList, mcpRead, mcpWrite, withMcpSftp } from '../../src/worker/mcp-sftp';
import { mcpHash } from '../../src/mcp-schema';

function file(content: string, exists = true) {
  const encoded = new TextEncoder().encode(content);
  const client = {
    openFile: vi.fn(async () => new Uint8Array([102])), parseHandleResponse: () => new Uint8Array([1]),
    closeHandle: vi.fn(async () => {}),
    readFile: vi.fn(async (_handle: unknown, offset: number, length: number) => offset >= encoded.length
      ? new Uint8Array([101, 1]) : new Uint8Array([103, ...encoded.subarray(offset, offset + length)])),
    parseDataResponse: (data: Uint8Array) => data.subarray(1),
    parseStatusResponse: (data: Uint8Array) => ({ code: data[1] ?? 0 }),
    lstat: vi.fn(async () => new Uint8Array(exists ? [105] : [101, 2])),
    parseAttrsResponse: () => ({ permissions: 0o100640 }),
    supportsAtomicRename: () => true,
    setPermissions: vi.fn(async () => new Uint8Array([101, 0])),
    writeFile: vi.fn(async () => new Uint8Array([101, 0])),
    rename: vi.fn(async () => new Uint8Array([101, 0])),
    atomicRename: vi.fn(async () => new Uint8Array([101, 0])),
    removeFile: vi.fn(async () => new Uint8Array([101, 0])),
  };
  return { client, sftp: client as unknown as SFTPClient };
}
afterEach(() => vi.useRealTimers());

describe('MCP SFTP initialization', () => {
  it('handles INIT write rejection and version cleanup without an unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start(controller) { input = controller; } });
    const failure = new Error('init_write_failed');
    const writable = new WritableStream<Uint8Array>({ write() { throw failure; } });
    const close = vi.fn(() => input.close());
    const session = { openSftpStream: async () => ({ readable, writable, close }), close: vi.fn() };
    const operation = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(withMcpSftp(session as unknown as Parameters<typeof withMcpSftp>[0], operation))
        .rejects.toBe(failure);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(readable.locked).toBe(false);
      expect(writable.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('bounded MCP SFTP text operations', () => {
  it('reads byte slices without splitting UTF-8 and provides hashes only for full files', async () => {
    const { sftp, client } = file('a你b');
    expect(await mcpRead(sftp, '/file', 0, 2)).toMatchObject({ content: 'a', nextOffset: 1, eof: false, fileHash: null });
    expect(await mcpRead(sftp, '/file', 1, 4)).toMatchObject({ content: '你b', nextOffset: 5, eof: true, fileHash: null });
    expect((await mcpRead(sftp, '/file')).fileHash).toBe(await mcpHash('a你b'));
    expect(client.closeHandle).toHaveBeenCalledTimes(3);
  });
  it('rejects binary and malformed UTF-8 while always releasing handles', async () => {
    const { sftp, client } = file('a\0b');
    await expect(mcpRead(sftp, '/file')).rejects.toThrow('text_files_only');
    expect(client.closeHandle).toHaveBeenCalledOnce();
    const malformed = file('valid');
    malformed.client.readFile.mockResolvedValueOnce(new Uint8Array([103, 0xff]));
    await expect(mcpRead(malformed.sftp, '/file')).rejects.toThrow('utf8_required');
  });
  it('creates via an exclusive temporary file, without truncating the destination', async () => {
    const { sftp, client } = file('', false);
    expect(await mcpWrite(sftp, '/file', 'hello')).toMatchObject({ writtenBytes: 5 });
    expect(client.openFile).toHaveBeenCalledWith(expect.stringMatching(/^\/file\.cloudssh-.*\.tmp$/), 2 | 8 | 32, 0o600);
    expect(client.rename).toHaveBeenCalledOnce();
    expect(client.atomicRename).not.toHaveBeenCalled();
    expect(client.setPermissions).toHaveBeenCalledWith(expect.any(String), 0o600);
  });
  it('requires the expected hash and atomic replacement; rejects conflicts without overwriting', async () => {
    const { sftp, client } = file('original');
    await expect(mcpWrite(sftp, '/file', 'new')).rejects.toThrow('expected_hash_required');
    await expect(mcpWrite(sftp, '/file', 'new', '0'.repeat(64))).rejects.toThrow('file_changed');
    expect(client.writeFile).not.toHaveBeenCalled();
    await mcpWrite(sftp, '/file', 'new', await mcpHash('original'));
    expect(client.atomicRename).toHaveBeenCalledOnce();
    expect(client.openFile).toHaveBeenCalledWith(expect.stringMatching(/^\/file\.cloudssh-.*\.tmp$/), 2 | 8 | 32, 0o600);
    expect(client.setPermissions).toHaveBeenCalledWith(expect.any(String), 0o640);
  });
  it('rejects symlinks and unsupported atomic replacement, and cleans up failed temporary writes', async () => {
    const f = file('original');
    f.client.parseAttrsResponse = () => ({ permissions: 0o120777 });
    await expect(mcpWrite(f.sftp, '/link', 'new', await mcpHash('original'))).rejects.toThrow('regular_file_required');
    f.client.parseAttrsResponse = () => ({ permissions: 0o100644 });
    f.client.supportsAtomicRename = () => false;
    await expect(mcpWrite(f.sftp, '/file', 'new', await mcpHash('original'))).rejects.toThrow('atomic_replace_unsupported');
    const failed = file('', false);
    failed.client.writeFile.mockRejectedValueOnce(new Error('transport failure'));
    await expect(mcpWrite(failed.sftp, '/file', 'new')).rejects.toThrow();
    expect(failed.client.rename).not.toHaveBeenCalled();
    expect(failed.client.closeHandle).toHaveBeenCalledOnce();
    expect(failed.client.removeFile).toHaveBeenCalledOnce();
  });
  it('bounds directory results by both count and encoded name size', async () => {
    const responses = [new Uint8Array([104]), new Uint8Array([101, 1])];
    const client = {
      openDir: async () => new Uint8Array(), parseHandleResponse: () => new Uint8Array(),
      readDir: async () => responses.shift()!, parseStatusResponse: () => ({ code: 1 }), closeHandle: vi.fn(async () => {}),
      parseNameResponse: () => Array.from({ length: 20 }, () => ({ filename: 'x'.repeat(16_000), attrs: {} })),
    };
    const result = await mcpList(client as unknown as SFTPClient, '/', 200);
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThanOrEqual(4);
    expect(client.closeHandle).toHaveBeenCalledOnce();
  });
});
