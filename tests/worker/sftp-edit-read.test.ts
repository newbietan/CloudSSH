import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import {
  SSH_FX_PERMISSION_DENIED,
  SSH_FXP_ATTRS,
  SSH_FXP_DATA,
  SSH_FXP_HANDLE,
  SSH_FXP_STATUS,
  SSH_S_IFDIR,
  SSH_S_IFREG,
} from '../../src/ssh/sftp-types';
import { containsBinaryMarker, SFTPHandler } from '../../src/worker/sftp-handler';

const EDITOR_MAX_FILE_SIZE = 2 * 1024 * 1024;

function createHandler(sftpOverrides: Record<string, unknown>) {
  const sendJSON = vi.fn();
  const sendBinary = vi.fn();
  const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON, sendBinary, vi.fn());
  const sftp = {
    stat: vi.fn(),
    parseAttrsResponse: vi.fn(),
    parseStatusResponse: vi.fn(),
    openFile: vi.fn(),
    parseHandleResponse: vi.fn(() => new Uint8Array([1])),
    readFile: vi.fn(),
    parseDataResponse: vi.fn(),
    closeHandle: vi.fn().mockResolvedValue(undefined),
    ...sftpOverrides,
  };

  Object.assign(handler as unknown as Record<string, unknown>, {
    ready: true,
    sftp,
  });

  return { handler, sendJSON, sendBinary, sftp };
}

function attrsResponse(): Uint8Array {
  return new Uint8Array([SSH_FXP_ATTRS]);
}

function dataResponse(content: Uint8Array): Uint8Array {
  const resp = new Uint8Array(content.length + 1);
  resp[0] = SSH_FXP_DATA;
  resp.set(content, 1);
  return resp;
}

function sentTypes(sendJSON: ReturnType<typeof vi.fn>): string[] {
  return sendJSON.mock.calls.map((call) => (call[0] as { type: string }).type);
}

describe('SFTP 在线编辑读取（editReadFile）', () => {
  it('超过 2MB 上限时拒绝且不打开文件', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(attrsResponse()),
      parseAttrsResponse: vi.fn(() => ({
        size: EDITOR_MAX_FILE_SIZE + 1,
        permissions: SSH_S_IFREG | 0o644,
        mtime: 1712345678,
      })),
    });

    await handler.editReadFile('/var/log/big.log');

    const first = sendJSON.mock.calls[0][0] as { type: string; operation: string; message: string };
    expect(first.type).toBe('sftp_error');
    expect(first.operation).toBe('edit');
    expect(first.message).toContain('文件过大');
    expect(sftp.openFile).not.toHaveBeenCalled();
    expect(sentTypes(sendJSON)).not.toContain('sftp_edit_start');
  });

  it('目录路径拒绝编辑', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(attrsResponse()),
      parseAttrsResponse: vi.fn(() => ({
        size: 4096,
        permissions: SSH_S_IFDIR | 0o755,
        mtime: 1712345678,
      })),
    });

    await handler.editReadFile('/home/deploy');

    const first = sendJSON.mock.calls[0][0] as { message: string };
    expect(first.message).toContain('目录');
    expect(sftp.openFile).not.toHaveBeenCalled();
  });

  it('stat 失败（权限拒绝）时以 edit 操作上报', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      parseStatusResponse: vi.fn(() => ({
        code: SSH_FX_PERMISSION_DENIED,
        message: 'Permission denied',
      })),
    });

    await handler.editReadFile('/root/.env');

    const first = sendJSON.mock.calls[0][0] as { operation: string; message: string };
    expect(first.operation).toBe('edit');
    expect(first.message).toContain('Permission denied');
    expect(sftp.openFile).not.toHaveBeenCalled();
  });

  it('二进制内容在发送任何报文前拒绝，并保证句柄关闭', async () => {
    const binary = new Uint8Array([0x23, 0x20, 0x63, 0x00, 0x6f, 0x6e, 0x66]);
    const { handler, sendJSON, sendBinary, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(attrsResponse()),
      parseAttrsResponse: vi.fn(() => ({
        size: binary.length,
        permissions: SSH_S_IFREG | 0o644,
        mtime: 1712345678,
      })),
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      readFile: vi.fn().mockResolvedValue(dataResponse(binary)),
      parseDataResponse: vi.fn(() => binary),
    });

    await handler.editReadFile('/home/deploy/app.bin');

    expect(sendBinary).not.toHaveBeenCalled();
    expect(sentTypes(sendJSON)).toEqual(['sftp_error']);
    const first = sendJSON.mock.calls[0][0] as { operation: string; message: string };
    expect(first.operation).toBe('edit');
    expect(first.message).toContain('二进制');
    expect(sftp.closeHandle).toHaveBeenCalledTimes(1);
  });

  it('文本文件按 start → 二进制分帧 → done 顺序下发并关闭句柄', async () => {
    const content = new TextEncoder().encode('KEY=value\n');
    const { handler, sendJSON, sendBinary, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(attrsResponse()),
      parseAttrsResponse: vi.fn(() => ({
        size: content.length,
        permissions: SSH_S_IFREG | 0o644,
        mtime: 1712345678,
      })),
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      readFile: vi.fn().mockResolvedValue(dataResponse(content)),
      parseDataResponse: vi.fn(() => content),
    });

    await handler.editReadFile('/home/deploy/.env');

    expect(sentTypes(sendJSON)).toEqual(['sftp_edit_start', 'sftp_edit_done']);
    expect(sendJSON.mock.calls[0][0]).toEqual({
      type: 'sftp_edit_start',
      path: '/home/deploy/.env',
      size: content.length,
      mtime: 1712345678,
    });
    expect(sendJSON.mock.calls[1][0]).toEqual({
      type: 'sftp_edit_done',
      path: '/home/deploy/.env',
      size: content.length,
      mtime: 1712345678,
    });
    expect(sendBinary).toHaveBeenCalledTimes(1);
    expect(Buffer.from(sendBinary.mock.calls[0][0] as Uint8Array).equals(Buffer.from(content))).toBe(
      true
    );
    expect(sftp.closeHandle).toHaveBeenCalledTimes(1);
  });

  it('大于单帧窗口的内容按 128KB 分帧且顺序正确', async () => {
    const size = 128 * 1024 * 2 + 1000;
    const content = new Uint8Array(size).fill(0x61);
    const { handler, sendBinary, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(attrsResponse()),
      parseAttrsResponse: vi.fn(() => ({
        size,
        permissions: SSH_S_IFREG | 0o644,
        mtime: 1,
      })),
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      readFile: vi.fn().mockImplementation((_handle: unknown, offset: number, length: number) => {
        const slice = content.subarray(offset, offset + length);
        return Promise.resolve(dataResponse(slice));
      }),
      parseDataResponse: vi.fn((resp: Uint8Array) => resp.slice(1)),
    });

    await handler.editReadFile('/home/deploy/large.txt');

    expect(sendBinary).toHaveBeenCalledTimes(3);
    const frameLengths = (sendBinary.mock.calls as Array<[Uint8Array]>).map(([d]) => d.length);
    expect(frameLengths).toEqual([128 * 1024, 128 * 1024, 1000]);
    expect(sftp.closeHandle).toHaveBeenCalledTimes(1);
  });

  it('读通道异常时以 edit 操作上报且不发送半截报文', async () => {
    const { handler, sendJSON, sendBinary } = createHandler({
      stat: vi.fn().mockResolvedValue(attrsResponse()),
      parseAttrsResponse: vi.fn(() => ({
        size: 10,
        permissions: SSH_S_IFREG | 0o644,
        mtime: 1,
      })),
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      readFile: vi.fn().mockRejectedValue(new Error('connection lost')),
    });

    await handler.editReadFile('/home/deploy/.env');

    expect(sendBinary).not.toHaveBeenCalled();
    expect(sentTypes(sendJSON)).toEqual(['sftp_error']);
    const first = sendJSON.mock.calls[0][0] as { operation: string };
    expect(first.operation).toBe('edit');
  });
});

describe('worker 侧二进制嗅探', () => {
  it('窗口内 NUL 判定为二进制', () => {
    expect(containsBinaryMarker(new Uint8Array([0x61, 0x00]))).toBe(true);
    expect(containsBinaryMarker(new Uint8Array([0x61, 0x62, 0x63]))).toBe(false);
    expect(containsBinaryMarker(new Uint8Array(0))).toBe(false);
  });
});

describe('SSH 会话接线', () => {
  it('分发 sftp_edit_read 且分享审计覆盖 edit 操作', () => {
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const source = readFileSync(join(rootDir, 'src/worker/ssh-session.ts'), 'utf8');
    expect(source).toContain("case 'sftp_edit_read':");
    expect(source).toContain('await this.sftpHandler.editReadFile(msg.path)');
    // 分享会话审计：edit 与 download/upload 同级纳管
    expect(source).toContain("['download', 'edit', 'upload'");
    expect(source).toContain("sftp_edit_done: 'edit'");
  });
});
