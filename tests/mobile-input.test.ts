import { describe, expect, it } from 'vitest';
import {
  applyMobileModifier,
  diffTextareaInput,
  isIOSLike,
  mobileTerminalKeySequence,
} from '../frontend/src/mobile-input';

describe('移动端 IME 输入补偿', () => {
  it('只发送 textarea 新增的标点和空格', () => {
    expect(diffTextareaInput('', '。')).toBe('。');
    expect(diffTextareaInput('中文', '中文 ')).toBe(' ');
    expect(diffTextareaInput('same', 'same')).toBe('');
  });

  it('对输入法替换和删除生成终端 DEL 序列', () => {
    expect(diffTextareaInput('ab', 'ac')).toBe('\x7fc');
    expect(diffTextareaInput('abcde', 'abXYde')).toBe('\x7f\x7f\x7fXYde');
    expect(diffTextareaInput('abc', 'a')).toBe('\x7f\x7f');
  });

  it('识别 iPhone、iPad 和触摸模式 iPadOS', () => {
    expect(
      isIOSLike({ userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5 })
    ).toBe(true);
    expect(isIOSLike({ userAgent: 'Mozilla/5.0', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      true
    );
    expect(isIOSLike({ userAgent: 'Mozilla/5.0', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      false
    );
  });
});

describe('移动端一次性修饰键', () => {
  it('将 Ctrl 字母转换成控制字符并在成功后消费状态', () => {
    expect(applyMobileModifier('c', 'ctrl')).toEqual({ data: '\x03', consumed: true });
    expect(applyMobileModifier('[', 'ctrl')).toEqual({ data: '\x1b', consumed: true });
  });

  it('Alt 添加 ESC 前缀，Ctrl 保留不支持的文本但消费一次性状态', () => {
    expect(applyMobileModifier('x', 'alt')).toEqual({ data: '\x1bx', consumed: true });
    expect(applyMobileModifier(' ', 'ctrl')).toEqual({ data: '\x00', consumed: true });
    expect(applyMobileModifier('中文', 'ctrl')).toEqual({ data: '中文', consumed: true });
    expect(applyMobileModifier('ß', 'ctrl')).toEqual({ data: 'ß', consumed: true });
    expect(applyMobileModifier('x', null)).toEqual({ data: 'x', consumed: false });
  });

  it('根据 application cursor mode 和修饰键生成与 xterm 一致的功能键序列', () => {
    expect(mobileTerminalKeySequence('arrow_up', false, null)).toBe('\x1b[A');
    expect(mobileTerminalKeySequence('arrow_up', true, null)).toBe('\x1bOA');
    expect(mobileTerminalKeySequence('arrow_left', true, 'ctrl')).toBe('\x1b[1;5D');
    expect(mobileTerminalKeySequence('home', true, 'alt')).toBe('\x1b[1;3H');
    expect(mobileTerminalKeySequence('page_up', false, 'ctrl')).toBe('\x1b[5;5~');
    expect(mobileTerminalKeySequence('escape', false, 'alt')).toBe('\x1b\x1b');
  });
});
