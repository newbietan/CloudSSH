export type MobileModifier = 'ctrl' | 'alt';
export type MobileTerminalKey =
  | 'escape'
  | 'tab'
  | 'arrow_up'
  | 'arrow_down'
  | 'arrow_right'
  | 'arrow_left'
  | 'home'
  | 'end'
  | 'page_up'
  | 'page_down';

/**
 * 计算 xterm 隐藏 textarea 在一次延迟输入前后的差异。
 * iOS 中文输入法会在 keyup 前才把标点或空格写入 textarea。
 */
export function diffTextareaInput(oldValue: string, newValue: string): string {
  if (oldValue === newValue) return '';

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < oldValue.length
    && commonPrefixLength < newValue.length
    && oldValue.charCodeAt(commonPrefixLength) === newValue.charCodeAt(commonPrefixLength)
  ) {
    commonPrefixLength++;
  }

  const removedCount = oldValue.length - commonPrefixLength;
  return `${'\x7f'.repeat(removedCount)}${newValue.substring(commonPrefixLength)}`;
}

/** 将移动端一次性 Ctrl/Alt 状态应用到下一段终端输入。 */
export function applyMobileModifier(
  data: string,
  modifier: MobileModifier | null,
): { data: string; consumed: boolean } {
  if (!modifier || !data) return { data, consumed: false };

  if (modifier === 'alt') {
    return { data: `\x1b${data}`, consumed: true };
  }

  if (data.length !== 1) return { data, consumed: true };
  if (data === ' ') return { data: '\x00', consumed: true };
  const originalCode = data.charCodeAt(0);
  const code = originalCode >= 97 && originalCode <= 122
    ? originalCode - 32
    : originalCode;
  if (code >= 64 && code <= 95) {
    return { data: String.fromCharCode(code & 0x1f), consumed: true };
  }
  if (data === '?') return { data: '\x7f', consumed: true };
  return { data, consumed: true };
}

/** 按照 xterm 的 application cursor mode 和修饰键生成终端按键序列。 */
export function mobileTerminalKeySequence(
  key: MobileTerminalKey,
  applicationCursorMode: boolean,
  modifier: MobileModifier | null,
): string {
  if (key === 'escape') return modifier === 'alt' ? '\x1b\x1b' : '\x1b';
  if (key === 'tab') return '\t';

  if (key === 'page_up' || key === 'page_down') {
    const number = key === 'page_up' ? '5' : '6';
    return modifier === 'ctrl' ? `\x1b[${number};5~` : `\x1b[${number}~`;
  }

  const final = {
    arrow_up: 'A',
    arrow_down: 'B',
    arrow_right: 'C',
    arrow_left: 'D',
    home: 'H',
    end: 'F',
  }[key];
  if (modifier) {
    const modifierCode = modifier === 'ctrl' ? 5 : 3;
    return `\x1b[1;${modifierCode}${final}`;
  }
  return applicationCursorMode ? `\x1bO${final}` : `\x1b[${final}`;
}

export function isIOSLike(navigatorLike: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPad|iPhone|iPod/.test(navigatorLike.userAgent)
    || (navigatorLike.platform === 'MacIntel' && navigatorLike.maxTouchPoints > 1);
}
