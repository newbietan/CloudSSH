/**
 * 最小 DER/ASN.1 读取器（私钥导入专用子集）。
 *
 * 仅供 PKCS#1 / PKCS#8 / SEC1 私钥解析使用，只实现所需子集：
 * TLV 读取、构造类型子节点解析、OID 解码、INTEGER / OCTET STRING / BIT STRING 取值。
 * 不支持 BER 不定长编码与多字节 tag——ssh-keygen / openssl 产出的私钥
 * 均为单字节 tag 的确定性 DER，遇到即明确报错。
 */

export class DerError extends Error {}

/** ASN.1 universal tag 常量（本项目只需这些）。 */
export const TAG_INTEGER = 0x02;
export const TAG_BIT_STRING = 0x03;
export const TAG_OCTET_STRING = 0x04;
/** NULL（算法参数占位）。 */
export const TAG_NULL = 0x05;
export const TAG_OID = 0x06;
export const TAG_SEQUENCE = 0x30;

/** 上下文相关构造标签：SEC1 ECPrivateKey 的 [0] 参数 / [1] 公钥。 */
export const TAG_CONTEXT_0 = 0xa0;
export const TAG_CONTEXT_1 = 0xa1;

export interface DerNode {
  /** 原始 tag 字节。 */
  tag: number;
  /** 值字节（原始类型）或子节点内容整体（构造类型）。 */
  value: Uint8Array;
  /** 构造类型的子节点；原始类型为 null。 */
  children: DerNode[] | null;
}

const CONSTRUCTED_FLAG = 0x20;

/** 解析整段 DER，要求恰好消耗全部字节。 */
export function parseDer(data: Uint8Array, context = 'DER'): DerNode {
  const [node, end] = readTLV(data, 0, context);
  if (end !== data.length) {
    throw new DerError(`${context}: 数据末尾存在多余字节（${data.length - end}）`);
  }
  return node;
}

function readTLV(
  data: Uint8Array,
  offset: number,
  context: string
): [DerNode, number] {
  if (offset + 2 > data.length) {
    throw new DerError(`${context}: TLV 头越界`);
  }
  const tag = data[offset];
  if ((tag & 0x1f) === 0x1f) {
    throw new DerError(`${context}: 不支持的多字节 tag 0x${tag.toString(16)}`);
  }

  let pos = offset + 1;
  const first = data[pos];
  pos += 1;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0) {
      throw new DerError(`${context}: 不支持的不定长编码`);
    }
    if (count > 4) {
      throw new DerError(`${context}: 长度字段过长`);
    }
    if (pos + count > data.length) {
      throw new DerError(`${context}: 长度字段越界`);
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + data[pos + i];
    }
    pos += count;
  }

  if (pos + length > data.length) {
    throw new DerError(`${context}: 值越界（需要 ${length} 字节，剩余 ${data.length - pos}）`);
  }
  const value = data.subarray(pos, pos + length);
  const end = pos + length;
  const children = (tag & CONSTRUCTED_FLAG) === 0 ? null : parseChildren(value, context);
  return [{ tag, value, children }, end];
}

function parseChildren(data: Uint8Array, context: string): DerNode[] {
  const children: DerNode[] = [];
  for (let offset = 0; offset < data.length; ) {
    const [node, end] = readTLV(data, offset, context);
    children.push(node);
    offset = end;
  }
  return children;
}

/** 断言节点 tag 并返回值字节。 */
export function expectTag(node: DerNode, tag: number, label: string, context: string): Uint8Array {
  if (node.tag !== tag) {
    throw new DerError(`${context}: 期望 ${label}（0x${tag.toString(16)}），实际 0x${node.tag.toString(16)}`);
  }
  return node.value;
}

/** 断言节点为 SEQUENCE 并返回子节点。 */
export function sequenceChildren(node: DerNode, context: string): DerNode[] {
  if (node.tag !== TAG_SEQUENCE || !node.children) {
    throw new DerError(`${context}: 期望 SEQUENCE，实际 0x${node.tag.toString(16)}`);
  }
  return node.children;
}

/**
 * INTEGER 的值字节：去掉正数的前导 0x00 符号填充（全零保留 1 字节）。
 * 与 auth.ts 中 SSH mpint 的规范化方式一致。
 */
export function integerBytes(node: DerNode, context: string): Uint8Array {
  const value = expectTag(node, TAG_INTEGER, 'INTEGER', context);
  return stripLeadingZeros(value);
}

/** 去除前导 0x00（至少保留 1 字节）。 */
export function stripLeadingZeros(value: Uint8Array): Uint8Array {
  if (value.length <= 1 || value[0] !== 0) {
    return value;
  }
  let zeros = 0;
  for (const byte of value) {
    if (byte !== 0) break;
    zeros++;
  }
  return value.subarray(Math.min(zeros, value.length - 1));
}

/** 断言 INTEGER 的值为给定小整数（用于 version 字段校验）。 */
export function expectIntegerValue(node: DerNode, expected: number, context: string): void {
  const value = integerBytes(node, context);
  if (value.length !== 1 || value[0] !== expected) {
    throw new DerError(`${context}: 版本字段异常（期望 ${expected}）`);
  }
}

/** 解码 OID 为点分十进制字符串。 */
export function decodeOid(node: DerNode, context: string): string {
  const value = expectTag(node, TAG_OID, 'OID', context);
  if (value.length === 0) {
    throw new DerError(`${context}: OID 为空`);
  }
  const arcs: string[] = [];
  if (value[0] < 40) {
    arcs.push('0', String(value[0]));
  } else if (value[0] < 80) {
    arcs.push('1', String(value[0] - 40));
  } else {
    arcs.push('2', String(value[0] - 80));
  }
  let pending = 0;
  let pendingBits = 0;
  for (let i = 1; i < value.length; i++) {
    const byte = value[i];
    pending = pending * 128 + (byte & 0x7f);
    pendingBits += 7;
    if (pendingBits > 40) {
      throw new DerError(`${context}: OID 子标识符过长`);
    }
    if ((byte & 0x80) === 0) {
      arcs.push(String(pending));
      pending = 0;
      pendingBits = 0;
    }
  }
  if (pendingBits > 0) {
    throw new DerError(`${context}: OID 截断`);
  }
  return arcs.join('.');
}

/**
 * BIT STRING 的内容字节：去掉首字节 unused-bits（SSH 场景要求为 0）。
 */
export function bitStringBytes(node: DerNode, context: string): Uint8Array {
  const value = expectTag(node, TAG_BIT_STRING, 'BIT STRING', context);
  if (value.length < 1 || value[0] !== 0) {
    throw new DerError(`${context}: BIT STRING 含未对齐位，不支持`);
  }
  return value.subarray(1);
}
