import { describe, expect, it } from 'vitest';
import { formatSFTPErrorMessage, shouldFallbackToDownload } from '../frontend/src/sftp-panel';

describe('SFTP double-click smart open fallback', () => {
  it('falls back to download when the worker rejects with binary code', () => {
    expect(shouldFallbackToDownload('binary', null)).toBe(true);
  });

  it('falls back to download when the worker rejects with too_large code', () => {
    expect(shouldFallbackToDownload('too_large', null)).toBe(true);
  });

  it('falls back to download when the client cannot decode the content', () => {
    expect(shouldFallbackToDownload(undefined, 'binary')).toBe(true);
    expect(shouldFallbackToDownload(undefined, 'encoding')).toBe(true);
  });

  it('does not fall back when no explicit not-editable signal is present', () => {
    // 超时/权限等其他错误在消息边界被降级为 undefined，不会触发回退下载
    expect(shouldFallbackToDownload(undefined, null)).toBe(false);
  });
});

describe('SFTP 错误信息语义增强', () => {
  it('当远端返回 Failure 时转换为包含磁盘空间排查指引的友好提示', () => {
    const raw = '写入文件失败: Failure';
    const formatted = formatSFTPErrorMessage(raw);
    expect(formatted).toContain('Failure');
    expect(formatted).toContain('df -h');
  });

  it('普通错误信息原样保留', () => {
    const raw = '目标路径是目录，无法覆盖';
    expect(formatSFTPErrorMessage(raw)).toBe(raw);
  });
});