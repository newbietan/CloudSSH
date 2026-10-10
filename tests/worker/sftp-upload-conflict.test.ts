import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import {
  SSH_FX_FAILURE,
  SSH_FX_NO_SUCH_FILE,
  SSH_FX_OK,
  SSH_FX_PERMISSION_DENIED,
  SSH_FXF_CREAT,
  SSH_FXF_EXCL,
  SSH_FXF_TRUNC,
  SSH_FXF_WRITE,
  SSH_FXP_ATTRS,
  SSH_FXP_HANDLE,
  SSH_FXP_STATUS,
  SSH_S_IFREG,
} from '../../src/ssh/sftp-types';
import {
  MAX_IN_FLIGHT_DIRECT_WRITES,
  MAX_IN_FLIGHT_TUNNEL_WRITES,
  SFTPHandler,
} from '../../src/worker/sftp-handler';

function createHandler(sftpOverrides: Record<string, unknown>) {
  const sendJSON = vi.fn();
  const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON, vi.fn(), vi.fn());
  const sftp = {
    stat: vi.fn(),
    parseAttrsResponse: vi.fn(),
    parseStatusResponse: vi.fn(),
    openFile: vi.fn(),
    parseHandleResponse: vi.fn(() => new Uint8Array([1])),
    ...sftpOverrides,
  };

  Object.assign(handler as unknown as Record<string, unknown>, {
    ready: true,
    sftp,
  });

  return { handler, sendJSON, sftp };
}

describe('SFTP 同名上传保护', () => {
  it('SSH 会话仅接受布尔 true 作为显式覆盖授权', () => {
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const source = readFileSync(join(rootDir, 'src/worker/ssh-session.ts'), 'utf8');
    expect(source).toContain(
      'this.sftpHandler.uploadStart(\n          msg.path,\n          msg.size || 0,\n          msg.overwrite === true'
    );
  });

  it('目标文件存在时返回冲突且不打开文件', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_ATTRS])),
      parseAttrsResponse: vi.fn(() => ({
        size: 2048,
        permissions: SSH_S_IFREG | 0o644,
      })),
    });

    await handler.uploadStart('/home/deploy/config.yml', 1024);

    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_conflict',
      path: '/home/deploy/config.yml',
      existingSize: 2048,
    });
    expect(sftp.openFile).not.toHaveBeenCalled();
  });

  it('新文件使用 EXCL 创建，避免检查后的竞态覆盖', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      parseStatusResponse: vi.fn(() => ({
        code: SSH_FX_NO_SUCH_FILE,
        message: '文件不存在',
      })),
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
    });

    await handler.uploadStart('/home/deploy/new.txt', 3);

    expect(sftp.openFile).toHaveBeenCalledWith(
      '/home/deploy/new.txt',
      SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_EXCL
    );
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_ready',
      path: '/home/deploy/new.txt',
      isTunnel: false,
    });
  });

  it('明确确认覆盖后才使用 TRUNC，且不重复执行 stat', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
    });

    await handler.uploadStart('/home/deploy/config.yml', 3, true);

    expect(sftp.stat).not.toHaveBeenCalled();
    expect(sftp.openFile).toHaveBeenCalledWith(
      '/home/deploy/config.yml',
      SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_TRUNC
    );
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_ready',
      path: '/home/deploy/config.yml',
      isTunnel: false,
    });
  });

  it('stat 权限错误时停止上传，不把检查失败当作文件不存在', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      stat: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      parseStatusResponse: vi.fn(() => ({
        code: SSH_FX_PERMISSION_DENIED,
        message: '权限被拒绝',
      })),
    });

    await handler.uploadStart('/root/config.yml', 3);

    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_error',
      operation: 'upload',
      message: '检查目标文件失败: 权限被拒绝',
    });
    expect(sftp.openFile).not.toHaveBeenCalled();
  });

  it('断点续传：resumeOffset > 0 时使用 WRITE | CREAT 追加写入，不截断也不重复 stat', async () => {
    const { handler, sendJSON, sftp } = createHandler({
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
    });

    await handler.uploadStart('/home/deploy/archive.tar.gz', 500 * 1024 * 1024, false, 300 * 1024 * 1024);

    expect(sftp.stat).not.toHaveBeenCalled();
    expect(sftp.openFile).toHaveBeenCalledWith(
      '/home/deploy/archive.tar.gz',
      SSH_FXF_WRITE | SSH_FXF_CREAT
    );
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_ready',
      path: '/home/deploy/archive.tar.gz',
      resumed: true,
      resumeOffset: 300 * 1024 * 1024,
      isTunnel: false,
    });
  });

  it('上传完成时执行 SHA-256 哈希完整性校验并返回对比结果', async () => {
    const sendJSON = vi.fn();
    const computeChecksum = vi.fn(async () => 'abc123def456');
    const handler = new SFTPHandler(
      1,
      new SSHChannel(),
      vi.fn(),
      sendJSON,
      vi.fn(),
      vi.fn(),
      false,
      computeChecksum
    );
    const sftp = {
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      closeHandle: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      parseHandleResponse: vi.fn(() => new Uint8Array([1])),
    };
    Object.assign(handler as unknown as Record<string, unknown>, { ready: true, sftp });

    await handler.uploadStart('/home/deploy/archive.tar.gz', 1024, true);
    await handler.uploadEnd('abc123def456');

    expect(computeChecksum).toHaveBeenCalledWith('/home/deploy/archive.tar.gz');
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_complete',
      path: '/home/deploy/archive.tar.gz',
      size: 0,
      hash: 'abc123def456',
      hashMatch: true,
    });
  });

  it('隧道流水线允许 16 个写请求，完整 2MiB 队列仍受并发上限及逐块 ACK 约束', async () => {
    let pendingWritesCount = 0;
    let maxObservedInFlight = 0;
    const writeResolvers: Array<() => void> = [];

    const sendJSON = vi.fn();
    const handler = new SFTPHandler(
      1,
      new SSHChannel(),
      vi.fn(),
      sendJSON,
      vi.fn(),
      vi.fn(),
      false,
      undefined,
      true
    );
    const sftp = {
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      parseHandleResponse: vi.fn(() => new Uint8Array([1])),
      writeFile: vi.fn(async () => {
        pendingWritesCount++;
        maxObservedInFlight = Math.max(maxObservedInFlight, pendingWritesCount);
        await new Promise<void>((resolve) => writeResolvers.push(resolve));
        pendingWritesCount--;
        return new Uint8Array([SSH_FXP_STATUS, 0, 0, 0, 0, 0, 0, 0, 0]);
      }),
      parseStatusResponse: vi.fn(() => ({ code: 0, message: 'OK' })),
    };
    Object.assign(handler as unknown as Record<string, unknown>, { ready: true, sftp });

    await handler.uploadStart('/test.bin', 10 * 1024 * 1024, true);

    expect(MAX_IN_FLIGHT_TUNNEL_WRITES).toBe(16);
    const totalChunks = 64; // The browser's maximum 2MiB window, not an unbounded queue.
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < totalChunks; i++) {
      promises.push(handler.onUploadChunk(new Uint8Array(32 * 1024)));
    }

    expect(maxObservedInFlight).toBe(16);
    expect(sftp.writeFile).toHaveBeenCalledTimes(16);
    expect(sendJSON.mock.calls.some(([frame]) => frame.type === 'sftp_upload_progress')).toBe(false);

    writeResolvers.shift()!();
    await vi.waitFor(() => expect(sftp.writeFile).toHaveBeenCalledTimes(17));
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_progress',
      loaded: 32 * 1024,
      total: 10 * 1024 * 1024,
    });

    // Release successive batches, including writes admitted by those releases.
    for (let pass = 0; pass < totalChunks && pendingWritesCount > 0; pass++) {
      while (writeResolvers.length > 0) writeResolvers.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(sftp.writeFile).toHaveBeenCalledTimes(totalChunks);
    expect(pendingWritesCount).toBe(0);
    await Promise.all(promises);
    expect(maxObservedInFlight).toBe(16);
    const progressFrames = sendJSON.mock.calls.filter(
      ([frame]) => frame.type === 'sftp_upload_progress'
    );
    expect(progressFrames).toHaveLength(totalChunks);
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_progress',
      loaded: 2 * 1024 * 1024,
      total: 10 * 1024 * 1024,
    });
  });

  it('直连模式放开在途限制为 MAX_IN_FLIGHT_DIRECT_WRITES (16 个分片 = 2MB)，满血释放物理带宽', async () => {
    let pendingWritesCount = 0;
    let maxObservedInFlight = 0;
    const writeResolvers: Array<() => void> = [];

    const sendJSON = vi.fn();
    const handler = new SFTPHandler(
      1,
      new SSHChannel(),
      vi.fn(),
      sendJSON,
      vi.fn(),
      vi.fn(),
      false,
      undefined,
      false
    );
    const sftp = {
      openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      parseHandleResponse: vi.fn(() => new Uint8Array([1])),
      writeFile: vi.fn(async () => {
        pendingWritesCount++;
        maxObservedInFlight = Math.max(maxObservedInFlight, pendingWritesCount);
        await new Promise<void>((resolve) => writeResolvers.push(resolve));
        pendingWritesCount--;
        return new Uint8Array([SSH_FXP_STATUS, 0, 0, 0, 0, 0, 0, 0, 0]);
      }),
      parseStatusResponse: vi.fn(() => ({ code: 0, message: 'OK' })),
    };
    Object.assign(handler as unknown as Record<string, unknown>, { ready: true, sftp });

    await handler.uploadStart('/test.bin', 10 * 1024 * 1024, true);

    // 连续抛送 17 个分片（MAX_IN_FLIGHT_DIRECT_WRITES + 1）
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < MAX_IN_FLIGHT_DIRECT_WRITES + 1; i++) {
      promises.push(handler.onUploadChunk(new Uint8Array(128 * 1024)));
    }

    await new Promise((r) => setTimeout(r, 10));
    expect(maxObservedInFlight).toBe(MAX_IN_FLIGHT_DIRECT_WRITES);
    expect(sftp.writeFile).toHaveBeenCalledTimes(MAX_IN_FLIGHT_DIRECT_WRITES);

    // 释放第 1 个分片
    writeResolvers[0]();
    await new Promise((r) => setTimeout(r, 10));

    expect(sftp.writeFile).toHaveBeenCalledTimes(MAX_IN_FLIGHT_DIRECT_WRITES + 1);

    while (writeResolvers.length > 0) {
      writeResolvers.shift()!();
    }
    await Promise.all(promises);
    expect(pendingWritesCount).toBe(0);
  });
});

describe('SFTP 目录递归删除 (rmdirRecursive)', () => {
  it('空目录直接通过原生 rmdir 成功删除', async () => {
    const sendJSON = vi.fn();
    const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON, vi.fn(), vi.fn());
    const sftp = {
      rmdir: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      parseStatusResponse: vi.fn(() => ({ code: SSH_FX_OK, message: 'OK' })),
    };
    Object.assign(handler as unknown as Record<string, unknown>, { ready: true, sftp });

    await handler.removeDirectory('/home/developer/empty_dir');

    expect(sftp.rmdir).toHaveBeenCalledWith('/home/developer/empty_dir');
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_rmdir_result',
      path: '/home/developer/empty_dir',
      success: true,
    });
  });

  it('非空目录遇 Failure (ENOTEMPTY) 自动触发递归清理并彻底删除', async () => {
    const sendJSON = vi.fn();
    const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON, vi.fn(), vi.fn());

    const removedFiles: string[] = [];
    const removedDirs: string[] = [];

    const sftp = {
      rmdir: vi.fn().mockImplementation(async (path: string) => {
        if (path === '/test_dir' && (removedFiles.length < 2 || removedDirs.length < 1)) {
          return new Uint8Array([SSH_FXP_STATUS]);
        }
        if (path === '/test_dir/sub_dir' && !removedFiles.includes('/test_dir/sub_dir/sub_file.txt')) {
          return new Uint8Array([SSH_FXP_STATUS]);
        }
        removedDirs.push(path);
        return new Uint8Array([SSH_FXP_STATUS]);
      }),
      openDir: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
      parseHandleResponse: vi.fn((resp: Uint8Array) => resp),
      closeHandle: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      listAllEntries: vi.fn().mockImplementation(async () => {
        if (sftp.listAllEntries.mock.calls.length === 1) {
          return {
            entries: [
              { filename: '.', attrs: { permissions: 0o040000 | 0o755 } },
              { filename: '..', attrs: { permissions: 0o040000 | 0o755 } },
              { filename: 'file1.txt', attrs: { permissions: 0o100000 | 0o644 } },
              { filename: 'sub_dir', attrs: { permissions: 0o040000 | 0o755 } },
            ],
            isTruncated: false,
          };
        }
        return {
          entries: [
            { filename: '.', attrs: { permissions: 0o040000 | 0o755 } },
            { filename: '..', attrs: { permissions: 0o040000 | 0o755 } },
            { filename: 'sub_file.txt', attrs: { permissions: 0o100000 | 0o644 } },
          ],
          isTruncated: false,
        };
      }),
      removeFile: vi.fn().mockImplementation(async (filePath: string) => {
        removedFiles.push(filePath);
        return new Uint8Array([SSH_FXP_STATUS]);
      }),
      parseStatusResponse: vi.fn(() => {
        if (sftp.parseStatusResponse.mock.calls.length === 1) {
          return { code: SSH_FX_FAILURE, message: 'Failure' };
        }
        return { code: SSH_FX_OK, message: 'OK' };
      }),
    };

    Object.assign(handler as unknown as Record<string, unknown>, { ready: true, sftp });

    await handler.removeDirectory('/test_dir');

    expect(removedFiles).toContain('/test_dir/file1.txt');
    expect(removedFiles).toContain('/test_dir/sub_dir/sub_file.txt');
    expect(removedDirs).toContain('/test_dir/sub_dir');
    expect(removedDirs).toContain('/test_dir');

    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_rmdir_result',
      path: '/test_dir',
      success: true,
    });
  });
});
