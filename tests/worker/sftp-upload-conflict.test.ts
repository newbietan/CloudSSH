import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import {
  SSH_FX_NO_SUCH_FILE,
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
import { SFTPHandler } from '../../src/worker/sftp-handler';

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
      'this.sftpHandler.uploadStart(msg.path, msg.size || 0, msg.overwrite === true)'
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
});
