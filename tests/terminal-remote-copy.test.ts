import { describe, expect, it } from 'vitest';
import { MAX_REMOTE_COPY_BYTES, parseRemoteCopy } from '../frontend/src/terminal-remote-copy';

const clipboard = (text: string) => `c;${Buffer.from(text, 'utf8').toString('base64')}`;

describe('OSC 52 write payloads', () => {
  it('preserves multilingual text, tabs, line endings and spaces', () => {
    const text = '\ufeff中文 🐱\t  \r\nline\n';
    expect(parseRemoteCopy(clipboard(text))).toBe(text);
  });

  it.each([
    'c;?', 'c;', ';eA==', 'p;eA==', 'cp;eA==', 'C;eA==', 'c', 'c;eA;', 'c;@', 'c;e A==',
    'c;eA==\n', 'c;e===', 'c;e',
  ])('ignores unsupported or malformed payload %j', payload => {
    expect(parseRemoteCopy(payload)).toBeNull();
  });

  it('rejects invalid UTF-8 and terminal control characters', () => {
    expect(parseRemoteCopy('c;/w==')).toBeNull();
    for (const char of ['\x00', '\x07', '\x1b', '\x7f', '\u009b']) {
      expect(parseRemoteCopy(clipboard(`text${char}`))).toBeNull();
    }
  });

  it('caps decoded bytes, including input whose padding hides the extra byte', () => {
    const text = '字'.repeat(Math.floor(MAX_REMOTE_COPY_BYTES / 3)) + 'x';
    expect(Buffer.byteLength(text)).toBe(MAX_REMOTE_COPY_BYTES);
    expect(parseRemoteCopy(clipboard(text))).toBe(text);
    expect(parseRemoteCopy(clipboard(`${text}x`))).toBeNull();
    expect(parseRemoteCopy(clipboard(`${text}more`))).toBeNull();
  });
});
