import { describe, expect, it } from 'vitest';
import { centerTerminalText, terminalTextWidth } from '../frontend/src/terminal-text';

describe('终端文本列宽', () => {
  it('按终端显示宽度计算中英文字符', () => {
    expect(terminalTextWidth('Connecting to CloudSSH')).toBe(22);
    expect(terminalTextWidth('正在连接 CloudSSH')).toBe(17);
    expect(terminalTextWidth('CloudSSH')).toBe(8);
  });

  it('将中英文横幅都精确填充到 34 列', () => {
    const chinese = centerTerminalText('正在连接 CloudSSH', 34);
    const english = centerTerminalText('Connecting to CloudSSH', 34);

    expect(terminalTextWidth(chinese)).toBe(34);
    expect(terminalTextWidth(english)).toBe(34);
    expect(chinese.trim()).toBe('正在连接 CloudSSH');
    expect(english.trim()).toBe('Connecting to CloudSSH');
  });

  it('文本过长时截断，仍不会撑破边框', () => {
    const result = centerTerminalText('这是一个非常非常长的终端连接状态提示', 12);
    expect(terminalTextWidth(result)).toBe(12);
    expect(result).toContain('…');
  });
});
