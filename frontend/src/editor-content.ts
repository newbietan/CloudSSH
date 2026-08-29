/**
 * SFTP 在线编辑的内容处理纯函数：二进制嗅探、编码探测、BOM/EOL 保留。
 *
 * 设计约定（与业界标准一致）：
 * - 二进制判定：前 BINARY_SNIFF_BYTES 字节内出现 NUL 字节（与 Git 嗅探窗口一致）；
 *   UTF-16 文本含 NUL，会被判定为二进制而拒绝编辑，这是主流编辑器的安全行为。
 * - 编辑器内统一使用 \n 换行，保存时按原文件主导 EOL（\n 或 \r\n）回写。
 * - UTF-8 BOM 在编辑期间剥离、保存时原样补回。
 * - 非 UTF-8 文本尝试 GB18030（GB 系列超集）解码成功时以只读模式呈现
 *   （浏览器无 GBK 系列编码器，无法安全回写，故不提供转换保存）。
 * - 本模块不依赖 DOM 与 CodeMirror，便于单元测试。
 */

export const EDITOR_MAX_FILE_SIZE = 2 * 1024 * 1024;
export const BINARY_SNIFF_BYTES = 8192;

export type SupportedEncoding = 'utf-8' | 'gb18030';

/** 编辑器内的规范化文本：统一 \n 换行、已剥离 BOM */
export interface DecodedContent {
  text: string;
  encoding: SupportedEncoding;
  bom: boolean;
  eol: '\n' | '\r\n';
}

export type ContentDecodeResult =
  | { ok: true; content: DecodedContent }
  | { ok: false; reason: 'binary' | 'encoding' };

export function containsNullByte(bytes: Uint8Array, limit: number = BINARY_SNIFF_BYTES): boolean {
  const bound = Math.min(bytes.length, limit);
  for (let i = 0; i < bound; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export function isEditorSizeAllowed(size: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= EDITOR_MAX_FILE_SIZE;
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

/**
 * 检测主导换行符。CRLF 计数严格占优时返回 \r\n，
 * 混合换行（含遗留的孤立 \r）一律按 \n 处理并在保存时归一。
 */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = countMatches(text, /\r\n/g);
  const lf = countMatches(text, /\n/g) - crlf;
  const cr = countMatches(text, /\r/g) - crlf;
  return crlf > lf + cr ? '\r\n' : '\n';
}

export function decodeEditorContent(bytes: Uint8Array): ContentDecodeResult {
  if (containsNullByte(bytes)) {
    return { ok: false, reason: 'binary' };
  }

  const bom =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = bom ? bytes.subarray(3) : bytes;

  try {
    const rawText = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    // 编辑器内统一 \n：先在原始文本上检测主导 EOL，再归一化换行
    const eol = detectEol(rawText);
    const text = rawText.replace(/\r\n?/g, '\n');
    return {
      ok: true,
      content: { text, encoding: 'utf-8', bom, eol },
    };
  } catch {
    // 非 UTF-8：GB18030 覆盖 GBK/GB2312 全部码位，仅用于只读呈现
  }

  try {
    const rawText = new TextDecoder('gb18030', { fatal: true }).decode(payload);
    const eol = detectEol(rawText);
    const text = rawText.replace(/\r\n?/g, '\n');
    return {
      ok: true,
      content: { text, encoding: 'gb18030', bom, eol },
    };
  } catch {
    return { ok: false, reason: 'encoding' };
  }
}

/**
 * 将编辑器规范化文本（\n 换行）编码回字节：按原文件 EOL 回写、补回 BOM。
 * 仅支持 UTF-8 回写（gb18030 文件以只读打开，不会走到这里）。
 */
export function encodeEditorContent(
  text: string,
  options: { bom: boolean; eol: '\n' | '\r\n' }
): Uint8Array {
  const joined = options.eol === '\r\n' ? text.split('\n').join('\r\n') : text;
  const body = new TextEncoder().encode(joined);

  if (!options.bom) return body;

  const out = new Uint8Array(body.length + 3);
  out[0] = 0xef;
  out[1] = 0xbb;
  out[2] = 0xbf;
  out.set(body, 3);
  return out;
}
