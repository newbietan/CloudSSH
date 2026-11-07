import { describe, expect, it, vi } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import {
  SSH_FX_NO_SUCH_FILE,
  SSH_FX_PERMISSION_DENIED,
  SSH_FXP_ATTRS,
  SSH_FXP_HANDLE,
  SSH_FXP_NAME,
  SSH_FXP_STATUS,
  SSH_S_IFDIR,
  SSH_S_IFLNK,
} from '../../src/ssh/sftp-types';
import { SFTPHandler } from '../../src/worker/sftp-handler';
import { SSHSession } from '../../src/worker/ssh-session';

function setup() {
  const sendJSON = vi.fn();
  const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON, vi.fn(), vi.fn());
  const sftp = {
    realpath: vi.fn(async () => new Uint8Array([SSH_FXP_NAME])),
    parseNameResponse: vi.fn(() => [{ filename: '/home/alice', attrs: {} }]),
    openDir: vi.fn(async () => new Uint8Array([SSH_FXP_HANDLE])),
    parseHandleResponse: vi.fn(() => new Uint8Array([1])),
    listAllEntries: vi.fn(async () => ({ entries: [
      { filename: 'to_dir', attrs: { permissions: SSH_S_IFLNK | 0o777, size: 9 } },
    ], isTruncated: false })),
    closeHandle: vi.fn(async () => {}),
    stat: vi.fn(async () => new Uint8Array([SSH_FXP_ATTRS])),
    parseAttrsResponse: vi.fn(() => ({ permissions: SSH_S_IFDIR | 0o755, size: 4096 })),
    parseStatusResponse: vi.fn(() => ({ code: SSH_FX_NO_SUCH_FILE, message: 'No such file' })),
  };
  Object.assign(handler, { ready: true, sftp });
  return { handler, sftp, sendJSON };
}

describe('SFTP logical symlink navigation', () => {
  it.each(['/bin', '/root/to_dir', '/root/to_dir/subdir'])(
    'opens and returns the logical absolute path %s without REALPATH or eager STAT',
    async (path) => {
      const { handler, sftp, sendJSON } = setup();
      await handler.listDirectory(path);
      expect(sftp.realpath).not.toHaveBeenCalled();
      expect(sftp.stat).not.toHaveBeenCalled();
      expect(sftp.openDir).toHaveBeenCalledExactlyOnceWith(path);
      expect(sendJSON).toHaveBeenCalledExactlyOnceWith({
        type: 'sftp_list_result', path, isTruncated: false,
        entries: [expect.objectContaining({ type: 'link', isLink: true, isDir: false })],
      });
      expect(sftp.closeHandle).toHaveBeenCalledOnce();
    }
  );

  it.each([['~', '.'], ['~/', '.'], ['.', '.'], ['relative', 'relative']])(
    'still resolves the initial home/relative path %s',
    async (path, expected) => {
      const { handler, sftp, sendJSON } = setup();
      await handler.listDirectory(path);
      expect(sftp.realpath).toHaveBeenCalledExactlyOnceWith(expected);
      expect(sftp.openDir).toHaveBeenCalledExactlyOnceWith('/home/alice');
      expect(sendJSON).toHaveBeenCalledWith(expect.objectContaining({ path: '/home/alice' }));
    }
  );

  it('reports a broken or inaccessible directory link without listing it', async () => {
    const { handler, sftp, sendJSON } = setup();
    sftp.openDir.mockResolvedValue(new Uint8Array([SSH_FXP_STATUS]));
    await handler.listDirectory('/root/broken');
    expect(sendJSON).toHaveBeenCalledExactlyOnceWith({
      type: 'sftp_error', operation: 'list', message: 'No such file',
    });
    expect(sftp.listAllEntries).not.toHaveBeenCalled();
  });

  it('closes the directory handle if listing the link target fails', async () => {
    const { handler, sftp, sendJSON } = setup();
    sftp.listAllEntries.mockRejectedValue(new Error('Permission denied'));
    await handler.listDirectory('/root/link');
    expect(sftp.closeHandle).toHaveBeenCalledOnce();
    expect(sendJSON).toHaveBeenCalledWith(expect.objectContaining({ operation: 'list' }));
  });
});

describe('SFTP target STAT correlation', () => {
  it('returns the followed target type, size, original path and request ID', async () => {
    const { handler, sftp, sendJSON } = setup();
    await handler.stat('/root/to_dir', 'open-1');
    expect(sftp.stat).toHaveBeenCalledExactlyOnceWith('/root/to_dir');
    expect(sendJSON).toHaveBeenCalledExactlyOnceWith({
      type: 'sftp_stat_result', path: '/root/to_dir', requestId: 'open-1',
      attrs: expect.objectContaining({ type: 'dir', size: 4096 }),
    });
  });

  it('keeps the legacy untagged editor STAT response shape', async () => {
    const { handler, sendJSON } = setup();
    await handler.stat('/file');
    expect(sendJSON.mock.calls[0][0]).not.toHaveProperty('requestId');
    expect(sendJSON.mock.calls[0][0]).toMatchObject({ type: 'sftp_stat_result', path: '/file' });
  });

  it.each([SSH_FX_NO_SUCH_FILE, SSH_FX_PERMISSION_DENIED])(
    'echoes the ID on target lookup status failure %s',
    async (code) => {
      const { handler, sftp, sendJSON } = setup();
      sftp.stat.mockResolvedValue(new Uint8Array([SSH_FXP_STATUS]));
      sftp.parseStatusResponse.mockReturnValue({ code, message: 'Unavailable target' });
      await handler.stat('/link', 'open-error');
      expect(sendJSON).toHaveBeenCalledExactlyOnceWith({
        type: 'sftp_error', operation: 'stat',
        message: 'Unavailable target', requestId: 'open-error',
      });
    }
  );

  it.each(['not-ready', 'unexpected-response', 'exception'])(
    'echoes the ID on %s failures too',
    async (failure) => {
      const { handler, sftp, sendJSON } = setup();
      if (failure === 'not-ready') Object.assign(handler, { ready: false });
      if (failure === 'unexpected-response') {
        sftp.stat.mockResolvedValue(new Uint8Array([SSH_FXP_NAME]));
      }
      if (failure === 'exception') sftp.stat.mockRejectedValue(new Error('closed'));
      await handler.stat('/link', 'open-error');
      expect(sendJSON).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        type: 'sftp_error', operation: 'stat', requestId: 'open-error',
      }));
    }
  );
});

function routingSession() {
  // Only the message router is under test; no socket/timer/session startup is needed.
  const session = Object.create(SSHSession.prototype) as any;
  const stat = vi.fn();
  const sendJSON = vi.fn();
  Object.assign(session, {
    state: 'ready', config: {}, sftpHandler: { stat }, sendSFTPJSON: sendJSON,
  });
  return { session, stat, sendJSON };
}

describe('SSH SFTP STAT routing', () => {
  it('forwards bounded optional IDs without changing the existing stat operation', async () => {
    const { session, stat } = routingSession();
    await session.handleSFTPMessage({ type: 'sftp_stat', path: '/link', requestId: 'open-1' });
    expect(stat).toHaveBeenCalledExactlyOnceWith('/link', 'open-1');
  });

  it.each([undefined, '', 42, 'x'.repeat(65)])('ignores invalid IDs: %s', async (requestId) => {
    const { session, stat } = routingSession();
    await session.handleSFTPMessage({ type: 'sftp_stat', path: '/link', requestId });
    expect(stat).toHaveBeenCalledExactlyOnceWith('/link', undefined);
  });

  it.each(['not-ready', 'share-denied', 'not-initialized'])(
    'correlates %s errors before dispatch without bypassing SFTP policy',
    async (failure) => {
      const { session, stat, sendJSON } = routingSession();
      if (failure === 'not-ready') session.state = 'closed';
      if (failure === 'share-denied') {
        session.config.sessionPolicy = { source: 'share', allowSftp: false };
      }
      if (failure === 'not-initialized') session.sftpHandler = null;
      await session.handleSFTPMessage({ type: 'sftp_stat', path: '/link', requestId: 'open-1' });
      expect(stat).not.toHaveBeenCalled();
      expect(sendJSON).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        type: 'sftp_error', operation: 'stat', requestId: 'open-1',
      }));
    }
  );
});
