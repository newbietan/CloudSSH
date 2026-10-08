import { describe, expect, it } from 'vitest';
import { getTerminalFillCommand, normalizeCodeLanguage } from '../frontend/src/agent/code-actions';

describe('Agent 代码块操作', () => {
  it('识别明确标注的单行 Shell 命令', () => {
    expect(normalizeCodeLanguage('language-BASH title=test')).toBe('bash');
    expect(getTerminalFillCommand('bash', 'sudo apt update')).toBe('sudo apt update');
    expect(getTerminalFillCommand('zsh', '$ git status')).toBe('git status');
    expect(getTerminalFillCommand('shell', '  pwd  ')).toBe('pwd');
    expect(getTerminalFillCommand('powershell', 'Get-Service sshd')).toBe('Get-Service sshd');
  });

  it('不为非 Shell、多行或包含控制字符的代码提供终端填入', () => {
    expect(getTerminalFillCommand('typescript', 'console.log("ok")')).toBeNull();
    expect(getTerminalFillCommand('', 'ls -la')).toBeNull();
    expect(getTerminalFillCommand('bash', 'cd /tmp\nls')).toBeNull();
    expect(getTerminalFillCommand('bash', 'echo ok\u001b[31m')).toBeNull();
  });
});
