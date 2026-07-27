import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  getTerminalFillCommand,
  normalizeCodeLanguage,
} from '../frontend/src/agent/code-actions';

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

  it('终端填入只作用于当前活动连接且不会附加回车', () => {
    const terminalSource = readFileSync(
      new URL('../frontend/src/terminal.ts', import.meta.url),
      'utf8',
    );
    const tabManagerSource = readFileSync(
      new URL('../frontend/src/tab-manager.ts', import.meta.url),
      'utf8',
    );
    const fillInputSource = terminalSource.slice(
      terminalSource.indexOf('fillInput(text: string)'),
      terminalSource.indexOf('setLatencyUpdatedHandler'),
    );

    expect(fillInputSource).toContain("if (!text || /[\\r\\n]/.test(text)) return false");
    expect(fillInputSource).toContain('this.trzszFilter.processTerminalInput(text)');
    expect(fillInputSource).not.toMatch(/(?:\\r|\\n|Enter).*processTerminalInput/);
    expect(tabManagerSource).toContain("activeTab?.id !== tab.id || tab.state !== 'connected'");
  });

  it('所有代码块提供复制，但仅安全命令增加填入按钮和目标标识', () => {
    const agentSource = readFileSync(
      new URL('../frontend/src/agent/agent-panel.ts', import.meta.url),
      'utf8',
    );

    expect(agentSource).toContain("this.createCodeActionButton('copy', 'content_copy'");
    expect(agentSource).toContain('getTerminalFillCommand(block.dataset.codeLanguage, code)');
    expect(agentSource).toContain("this.createCodeActionButton('fill', 'input'");
    expect(agentSource).toContain("t('agent.codeTarget', { target: target.label })");
  });
});
