import { describe, expect, it, vi } from 'vitest';
import {
  isBlockedFilePath,
  needsFileReadConfirmation,
  needsFileWriteConfirmation,
  normalizeSecurityPath,
} from '../../src/worker/agent/safety';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { ToolExecutor } from '../../src/worker/agent/tool-executor';
import { parseToolArguments } from '../../src/worker/agent/tools';

function makeExecutor(execHandler?: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>) {
  const defaultExec = async (_command: string) => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  });
  const execCommand = vi.fn(execHandler || defaultExec);
  const askConfirmation = vi.fn(async () => true);
  const executor = new ToolExecutor(
    new TerminalContext(),
    execCommand,
    askConfirmation,
    undefined
  );
  return { executor, execCommand, askConfirmation };
}

describe('File Security Rules (safety.ts)', () => {
  describe('normalizeSecurityPath', () => {
    it('normalizes relative and absolute paths and resolves dot components', () => {
      expect(normalizeSecurityPath('/var/log/../../etc/nginx/nginx.conf')).toBe('/etc/nginx/nginx.conf');
      expect(normalizeSecurityPath('/etc/./passwd')).toBe('/etc/passwd');
      expect(normalizeSecurityPath('app/src/../../etc/shadow')).toBe('etc/shadow');
      expect(normalizeSecurityPath('/a/b/c/../../d')).toBe('/a/d');
    });
  });

  describe('isBlockedFilePath', () => {
    it('blocks raw block devices and special virtual files', () => {
      expect(isBlockedFilePath('/dev/sda').blocked).toBe(true);
      expect(isBlockedFilePath('/dev/nvme0n1p1').blocked).toBe(true);
      expect(isBlockedFilePath('/proc/sys/vm/drop_caches').blocked).toBe(true);
      expect(isBlockedFilePath('/sys/kernel/debug').blocked).toBe(true);
    });

    it('allows normal paths and /dev/null', () => {
      expect(isBlockedFilePath('/dev/null').blocked).toBe(false);
      expect(isBlockedFilePath('/home/user/test.txt').blocked).toBe(false);
      expect(isBlockedFilePath('/etc/nginx/nginx.conf').blocked).toBe(false);
    });
  });

  describe('needsFileReadConfirmation', () => {
    it('requires confirmation when reading shadow passwords or private keys', () => {
      expect(needsFileReadConfirmation('/etc/shadow').required).toBe(true);
      expect(needsFileReadConfirmation('/etc/gshadow').required).toBe(true);
      expect(needsFileReadConfirmation('/root/.ssh/id_rsa').required).toBe(true);
      expect(needsFileReadConfirmation('/home/user/.ssh/id_ed25519').required).toBe(true);
      expect(needsFileReadConfirmation('/etc/ssl/certs/server.key').required).toBe(true);
      expect(needsFileReadConfirmation('/path/to/key.pem').required).toBe(true);
    });

    it('allows reading normal configs and logs without confirmation', () => {
      expect(needsFileReadConfirmation('/var/log/nginx/access.log').required).toBe(false);
      expect(needsFileReadConfirmation('/etc/nginx/nginx.conf').required).toBe(false);
      expect(needsFileReadConfirmation('/home/user/app/index.js').required).toBe(false);
    });
  });

  describe('needsFileWriteConfirmation', () => {
    it('requires confirmation for writing system files, boot, binaries, cron, and ssh keys', () => {
      expect(needsFileWriteConfirmation('/etc/nginx/nginx.conf').required).toBe(true);
      expect(needsFileWriteConfirmation('/boot/grub/grub.cfg').required).toBe(true);
      expect(needsFileWriteConfirmation('/usr/bin/python3').required).toBe(true);
      expect(needsFileWriteConfirmation('/var/spool/cron/root').required).toBe(true);
      expect(needsFileWriteConfirmation('/home/user/.ssh/authorized_keys').required).toBe(true);
      expect(needsFileWriteConfirmation('/root/.bashrc').required).toBe(true);
    });

    it('does not require confirmation for ordinary project/app files', () => {
      expect(needsFileWriteConfirmation('/home/user/app/server.js').required).toBe(false);
      expect(needsFileWriteConfirmation('/tmp/test.log').required).toBe(false);
      expect(needsFileWriteConfirmation('/var/www/html/index.html').required).toBe(false);
    });
  });
});

describe('Tool Argument Parsing (tools.ts)', () => {
  it('parses read_file arguments correctly', () => {
    const parsed = parseToolArguments(
      'read_file',
      JSON.stringify({ path: '/etc/nginx/nginx.conf', offset: 10, limit: 50 })
    );
    expect(parsed.path).toBe('/etc/nginx/nginx.conf');
    expect(parsed.offset).toBe(10);
    expect(parsed.limit).toBe(50);
  });

  it('allows null offset and limit for read_file', () => {
    const parsed = parseToolArguments(
      'read_file',
      JSON.stringify({ path: '/var/log/syslog' })
    );
    expect(parsed.path).toBe('/var/log/syslog');
    expect(parsed.offset).toBeNull();
    expect(parsed.limit).toBeNull();
  });

  it('parses write_file arguments correctly with optional search', () => {
    const parsed = parseToolArguments(
      'write_file',
      JSON.stringify({
        path: '/tmp/test.txt',
        content: 'hello',
        search: 'old',
      })
    );
    expect(parsed.path).toBe('/tmp/test.txt');
    expect(parsed.content).toBe('hello');
    expect(parsed.search).toBe('old');
  });
});

describe('ToolExecutor: read_file', () => {
  it('rejects empty path', async () => {
    const { executor } = makeExecutor();
    const res = JSON.parse(await executor.execute('read_file', { path: '' }));
    expect(res.error).toBe('路径不能为空');
  });

  it('requires confirmation on sensitive file and respects user rejection', async () => {
    const { executor, askConfirmation, execCommand } = makeExecutor();
    askConfirmation.mockResolvedValueOnce(false);

    const res = JSON.parse(await executor.execute('read_file', { path: '/etc/shadow' }));
    expect(askConfirmation).toHaveBeenCalledWith('/etc/shadow', expect.stringContaining('密码哈希'), undefined);
    expect(res.user_rejected).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('reads normal file successfully and returns parsed lines', async () => {
    const { executor, execCommand } = makeExecutor(async (cmd) => {
      expect(cmd).toContain('---CLOUDSSH_FILE_DIV---');
      return {
        stdout: '100\n---CLOUDSSH_FILE_DIV---\nline 1\nline 2\nline 3',
        stderr: '',
        exitCode: 0,
      };
    });

    const res = JSON.parse(
      await executor.execute('read_file', { path: '/var/log/test.log', offset: 1, limit: 10 })
    );
    expect(res.path).toBe('/var/log/test.log');
    expect(res.total_lines).toBe(100);
    expect(res.content).toBe('line 1\nline 2\nline 3');
    expect(res.truncated).toBe(false);
    expect(execCommand).toHaveBeenCalled();
  });

  it('handles file not found error', async () => {
    const { executor } = makeExecutor(async () => ({
      stdout: '__NOT_FOUND__\n',
      stderr: '',
      exitCode: 1,
    }));

    const res = JSON.parse(await executor.execute('read_file', { path: '/nonexistent.txt' }));
    expect(res.error).toContain('文件不存在');
  });

  it('handles directory error', async () => {
    const { executor } = makeExecutor(async () => ({
      stdout: '__IS_DIR__\n',
      stderr: '',
      exitCode: 1,
    }));

    const res = JSON.parse(await executor.execute('read_file', { path: '/var/log' }));
    expect(res.error).toContain('目录而非普通文件');
  });

  it('detects binary file and refuses plain text read', async () => {
    const { executor } = makeExecutor(async () => ({
      stdout: '10\n---CLOUDSSH_FILE_DIV---\nELF\x00\x01\x02',
      stderr: '',
      exitCode: 0,
    }));

    const res = JSON.parse(await executor.execute('read_file', { path: '/bin/ls' }));
    expect(res.error).toContain('包含二进制数据');
  });
});

describe('ToolExecutor: write_file', () => {
  it('blocks dangerous block device writes outright', async () => {
    const { executor, askConfirmation, execCommand } = makeExecutor();
    const res = JSON.parse(
      await executor.execute('write_file', { path: '/dev/sda', content: 'zero' })
    );
    expect(res.blocked).toBe(true);
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('asks user confirmation when writing to /etc/ and aborts if rejected', async () => {
    const { executor, askConfirmation, execCommand } = makeExecutor();
    askConfirmation.mockResolvedValueOnce(false);

    const res = JSON.parse(
      await executor.execute('write_file', { path: '/etc/nginx/nginx.conf', content: 'new config' })
    );
    expect(askConfirmation).toHaveBeenCalledWith(
      '/etc/nginx/nginx.conf',
      expect.stringContaining('修改系统核心配置文件'),
      undefined
    );
    expect(res.user_rejected).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('writes content via base64 stream on full overwrite', async () => {
    const { executor, execCommand } = makeExecutor(async (cmd) => {
      expect(cmd).toContain('base64');
      return { stdout: '42\n', stderr: '', exitCode: 0 };
    });

    const res = JSON.parse(
      await executor.execute('write_file', { path: '/home/user/app/file.txt', content: 'hello world' })
    );
    expect(res.success).toBe(true);
    expect(res.bytes_written).toBe(42);
    expect(execCommand).toHaveBeenCalled();
  });

  describe('patch mode (search provided)', () => {
    it('returns error if search text is not in file', async () => {
      const { executor } = makeExecutor(async (cmd) => {
        if (cmd.includes('cat')) {
          return { stdout: 'server { listen 80; }', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const res = JSON.parse(
        await executor.execute('write_file', {
          path: '/home/user/nginx.conf',
          content: 'listen 443;',
          search: 'listen 8080;',
        })
      );
      expect(res.error).toContain('未在文件中找到匹配的原始文本');
    });

    it('returns error if search text matches multiple locations', async () => {
      const { executor } = makeExecutor(async (cmd) => {
        if (cmd.includes('cat')) {
          return { stdout: 'listen 80;\nother;\nlisten 80;', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const res = JSON.parse(
        await executor.execute('write_file', {
          path: '/home/user/nginx.conf',
          content: 'listen 443;',
          search: 'listen 80;',
        })
      );
      expect(res.error).toContain('出现多次');
      expect(res.occurrences).toBe(2);
    });

    it('patches successfully when unique match is found', async () => {
      let writtenPayload = '';
      const { executor, execCommand } = makeExecutor(async (cmd) => {
        if (cmd.includes('cat')) {
          return { stdout: 'server {\n    listen 80;\n}\n', stderr: '', exitCode: 0 };
        }
        writtenPayload = cmd;
        return { stdout: '35\n', stderr: '', exitCode: 0 };
      });

      const res = JSON.parse(
        await executor.execute('write_file', {
          path: '/home/user/nginx.conf',
          content: '    listen 443;',
          search: '    listen 80;',
        })
      );
      expect(res.success).toBe(true);
      expect(res.patched).toBe(true);
      expect(execCommand).toHaveBeenCalledTimes(2); // 1 read + 1 write
      expect(writtenPayload).toContain('base64');
    });
  });
});
