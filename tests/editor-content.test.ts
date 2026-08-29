import { describe, expect, it } from 'vitest';
import {
  BINARY_SNIFF_BYTES,
  containsNullByte,
  decodeEditorContent,
  detectEol,
  EDITOR_MAX_FILE_SIZE,
  encodeEditorContent,
  isEditorSizeAllowed,
} from '../frontend/src/editor-content';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function withBom(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(bytes, 3);
  return out;
}

function encodeDecoded(original: Uint8Array): Uint8Array {
  const decoded = decodeEditorContent(original);
  if (!decoded.ok) throw new Error(`unexpected decode failure: ${decoded.reason}`);
  return encodeEditorContent(decoded.content.text, {
    bom: decoded.content.bom,
    eol: decoded.content.eol,
  });
}

describe('二进制嗅探', () => {
  it('纯文本字节不含 NUL 不误判', () => {
    expect(containsNullByte(utf8('hello 配置\nworld\r\n'))).toBe(false);
  });

  it('嗅探窗口内出现 NUL 判定为二进制', () => {
    const bytes = new Uint8Array([0x61, 0x00, 0x62]);
    expect(containsNullByte(bytes)).toBe(true);
  });

  it('嗅探窗口外的 NUL 不参与判定', () => {
    const bytes = new Uint8Array(BINARY_SNIFF_BYTES + 4).fill(0x61);
    bytes[BINARY_SNIFF_BYTES + 2] = 0;
    expect(containsNullByte(bytes)).toBe(false);
  });

  it('UTF-16 文本因 NUL 被判定为二进制（与 Git 行为一致）', () => {
    expect(containsNullByte(new Uint8Array([0x61, 0x00, 0x62, 0x00]))).toBe(true);
  });
});

describe('EOL 检测', () => {
  it('CRLF 主导时返回 CRLF', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('\r\n');
  });

  it('LF 主导时返回 LF', () => {
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
  });

  it('混合换行含孤立 CR 时保守按 LF 归一', () => {
    expect(detectEol('a\rb\nc')).toBe('\n');
  });

  it('空文本默认 LF', () => {
    expect(detectEol('')).toBe('\n');
  });
});

describe('编辑内容解码', () => {
  it('UTF-8 文本解码并保留元信息', () => {
    const result = decodeEditorContent(utf8('# title\nserver {\n}\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.encoding).toBe('utf-8');
    expect(result.content.bom).toBe(false);
    expect(result.content.eol).toBe('\n');
    expect(result.content.text).toBe('# title\nserver {\n}\n');
  });

  it('剥离 UTF-8 BOM 并记录标志', () => {
    const result = decodeEditorContent(withBom(utf8('key=value')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.bom).toBe(true);
    expect(result.content.text).toBe('key=value');
  });

  it('CRLF 文件检测为 CRLF', () => {
    const result = decodeEditorContent(utf8('a\r\nb\r\n'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.eol).toBe('\r\n');
  });

  it('包含 NUL 的字节拒绝为二进制', () => {
    const result = decodeEditorContent(new Uint8Array([0x61, 0x00, 0x62]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('binary');
  });

  it('GBK 中文经 GB18030 解码成功（只读路径）', () => {
    // “配置” 的 GBK 编码：配=C5E4 置=D6C3
    const result = decodeEditorContent(new Uint8Array([0xc5, 0xe4, 0xd6, 0xc3]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.encoding).toBe('gb18030');
    expect(result.content.text).toBe('配置');
  });

  it('UTF-8 与 GB18030 均无法解码时返回 encoding 失败', () => {
    // 0xFF 既非合法 UTF-8 序列，也非 GB18030 合法首字节
    const result = decodeEditorContent(new Uint8Array([0xff, 0x41]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('encoding');
  });

  it('空文件按 UTF-8 空文本处理', () => {
    const result = decodeEditorContent(new Uint8Array(0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.text).toBe('');
    expect(result.content.encoding).toBe('utf-8');
    expect(result.content.bom).toBe(false);
  });
});

describe('编辑内容编码回写', () => {
  it('LF 无 BOM 文件字节级还原', () => {
    const original = utf8('# title\nlisten 80;\n');
    expect(Buffer.from(encodeDecoded(original)).equals(Buffer.from(original))).toBe(true);
  });

  it('CRLF + BOM 文件字节级还原', () => {
    const original = withBom(utf8('a\r\nb\r\n'));
    expect(Buffer.from(encodeDecoded(original)).equals(Buffer.from(original))).toBe(true);
  });

  it('编辑后的内容按原 EOL 回写', () => {
    const decoded = decodeEditorContent(utf8('a\r\nb\r\n'));
    if (!decoded.ok) throw new Error('unexpected decode failure');
    const encoded = encodeEditorContent(decoded.content.text.replace('b', 'c'), {
      bom: decoded.content.bom,
      eol: decoded.content.eol,
    });
    expect(new TextDecoder().decode(encoded)).toBe('a\r\nc\r\n');
  });

  it('保存时补回 BOM', () => {
    const encoded = encodeEditorContent('hello', { bom: true, eol: '\n' });
    expect([encoded[0], encoded[1], encoded[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(encoded.subarray(3))).toBe('hello');
  });

  it('解码→编码→再解码往返一致', () => {
    const original = withBom(utf8('[unit]\r\nAfter=network.target\r\n'));
    const first = decodeEditorContent(original);
    if (!first.ok) throw new Error('unexpected decode failure');
    const second = decodeEditorContent(
      encodeEditorContent(first.content.text, {
        bom: first.content.bom,
        eol: first.content.eol,
      })
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.content).toEqual(first.content);
  });
});

describe('在线编辑大小上限', () => {
  it('边界值符合 2MB 上限语义', () => {
    expect(EDITOR_MAX_FILE_SIZE).toBe(2 * 1024 * 1024);
    expect(isEditorSizeAllowed(0)).toBe(true);
    expect(isEditorSizeAllowed(EDITOR_MAX_FILE_SIZE)).toBe(true);
    expect(isEditorSizeAllowed(EDITOR_MAX_FILE_SIZE + 1)).toBe(false);
    expect(isEditorSizeAllowed(-1)).toBe(false);
    expect(isEditorSizeAllowed(Number.NaN)).toBe(false);
    expect(isEditorSizeAllowed(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
