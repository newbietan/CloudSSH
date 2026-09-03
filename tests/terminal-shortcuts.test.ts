import { describe, expect, it } from 'vitest';
import { matchTerminalShortcut } from '../frontend/src/terminal';

describe('终端快捷键匹配', () => {
  it('识别 Ctrl+Shift+F 搜索快捷键', () => {
    expect(
      matchTerminalShortcut({
        key: 'F',
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
      })
    ).toBe('search');
    expect(
      matchTerminalShortcut({
        key: 'f',
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
      })
    ).toBe('search');
  });

  it('识别 macOS Cmd+F 搜索快捷键', () => {
    expect(
      matchTerminalShortcut({
        key: 'f',
        ctrlKey: false,
        shiftKey: false,
        metaKey: true,
        altKey: false,
      })
    ).toBe('search');
    expect(
      matchTerminalShortcut({
        key: 'F',
        ctrlKey: false,
        shiftKey: false,
        metaKey: true,
        altKey: false,
      })
    ).toBe('search');
  });

  it('识别 macOS Cmd+K 清屏/清除缓冲区快捷键', () => {
    expect(
      matchTerminalShortcut({
        key: 'k',
        ctrlKey: false,
        shiftKey: false,
        metaKey: true,
        altKey: false,
      })
    ).toBe('clear');
    expect(
      matchTerminalShortcut({
        key: 'K',
        ctrlKey: false,
        shiftKey: false,
        metaKey: true,
        altKey: false,
      })
    ).toBe('clear');
  });

  it('识别 Win/Linux Ctrl+Shift+K 清屏/清除缓冲区快捷键', () => {
    expect(
      matchTerminalShortcut({
        key: 'k',
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
      })
    ).toBe('clear');
  });

  it('不拦截 Shell 默认行编辑 Ctrl+K（避免与剪切到行尾冲突）', () => {
    expect(
      matchTerminalShortcut({
        key: 'k',
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
      })
    ).toBeNull();
  });

  it('忽略不相关的按键组合', () => {
    expect(
      matchTerminalShortcut({
        key: 'c',
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
      })
    ).toBeNull();
    expect(
      matchTerminalShortcut({
        key: 'Enter',
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        altKey: false,
      })
    ).toBeNull();
  });
});
