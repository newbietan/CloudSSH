/**
 * 计算字符串在等宽终端中占用的列数。
 * CJK 全角字符和常见 Emoji 占 2 列，组合字符不单独占列。
 */
export function terminalTextWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      continue;
    }
    if (/\p{Mark}/u.test(char)) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/** 将文本按终端显示列宽居中，并保证结果恰好占用指定列数。 */
export function centerTerminalText(text: string, columns: number): string {
  const fittedText = truncateToColumns(text, columns);
  const remaining = Math.max(0, columns - terminalTextWidth(fittedText));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${' '.repeat(left)}${fittedText}${' '.repeat(right)}`;
}

function truncateToColumns(text: string, columns: number): string {
  if (terminalTextWidth(text) <= columns) return text;
  if (columns <= 0) return '';

  const ellipsis = '…';
  const contentColumns = Math.max(0, columns - terminalTextWidth(ellipsis));
  let result = '';
  let width = 0;
  for (const char of text) {
    const charWidth = terminalTextWidth(char);
    if (width + charWidth > contentColumns) break;
    result += char;
    width += charWidth;
  }
  return result + ellipsis;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
