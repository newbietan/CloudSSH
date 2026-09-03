import { describe, expect, it } from 'vitest';
import { validateRemoteName } from '../frontend/src/sftp-dialogs';

describe('SFTP 远端文件名校验 (validateRemoteName)', () => {
  it('允许正常的文件名和目录名', () => {
    expect(validateRemoteName('app.js')).toBeNull();
    expect(validateRemoteName('nginx-2025.conf')).toBeNull();
    expect(validateRemoteName('中文文档.pdf')).toBeNull();
    expect(validateRemoteName('.env')).toBeNull();
  });

  it('拒绝当前目录 . 与父级目录 ..', () => {
    expect(validateRemoteName('.')).not.toBeNull();
    expect(validateRemoteName('..')).not.toBeNull();
  });

  it('拒绝包含斜杠或空字符的危险路径', () => {
    expect(validateRemoteName('foo/bar')).not.toBeNull();
    expect(validateRemoteName('/etc')).not.toBeNull();
    expect(validateRemoteName('test\0bad')).not.toBeNull();
  });
});
