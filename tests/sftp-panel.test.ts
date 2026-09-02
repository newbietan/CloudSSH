import { describe, expect, it } from 'vitest';
import { shouldFallbackToDownload } from '../frontend/src/sftp-panel';

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