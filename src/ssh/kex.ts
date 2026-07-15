import { SSH_MSG_KEXINIT, KEXInitMessage } from '../types';
import {
  SUPPORTED_ENCRYPTION_ALGORITHMS,
  SUPPORTED_KEX_ALGORITHMS,
  SUPPORTED_MAC_ALGORITHMS
} from './algorithms';
import { concat } from './utils';

export class KEXInitBuilder {
  static build(): Uint8Array {
    const parts: Uint8Array[] = [];

    parts.push(new Uint8Array([SSH_MSG_KEXINIT]));

    const cookie = new Uint8Array(16);
    crypto.getRandomValues(cookie);
    parts.push(cookie);

    const algorithmLists = [
      // RFC 8301 §2.1: ext-info-c 作为伪算法名插入到 kex_algorithms 列表的最前面，
      // 通知服务器客户端愿意接收 SSH_MSG_EXT_INFO（用于 server-sig-algs 协商）
      ['ext-info-c', ...SUPPORTED_KEX_ALGORITHMS].join(','),
      'ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256,ssh-rsa',
      SUPPORTED_ENCRYPTION_ALGORITHMS.join(','),
      SUPPORTED_ENCRYPTION_ALGORITHMS.join(','),
      SUPPORTED_MAC_ALGORITHMS.join(','),
      SUPPORTED_MAC_ALGORITHMS.join(','),
      'none',
      'none',
      '',
      '',
    ];

    for (const name of algorithmLists) {
      const encoded = new TextEncoder().encode(name);
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, encoded.length, false);
      parts.push(len);
      parts.push(encoded);
    }

    parts.push(new Uint8Array([0]));

    const reserved = new Uint8Array(4);
    parts.push(reserved);

    return concat(...parts);
  }
}

export function parseKEXInit(data: Uint8Array): KEXInitMessage {
  let offset = 1;

  offset += 16;

  const lists: string[] = [];
  for (let i = 0; i < 10; i++) {
    if (offset + 4 > data.length) {
      throw new Error(`Malformed KEXINIT: truncated length field at list ${i}, offset=${offset}, dataLen=${data.length}`);
    }
    const len = (data[offset] << 24) | (data[offset+1] << 16) |
                (data[offset+2] << 8) | data[offset+3];
    offset += 4;
    if (len < 0 || offset + len > data.length) {
      throw new Error(`Malformed KEXINIT: list ${i} length ${len} exceeds packet boundary (offset=${offset}, dataLen=${data.length})`);
    }
    const name = new TextDecoder().decode(data.slice(offset, offset + len));
    lists.push(name);
    offset += len;
  }

  return {
    kexAlgorithms: lists[0].split(','),
    hostKeyAlgorithms: lists[1].split(','),
    encryptionC2S: lists[2].split(','),
    encryptionS2C: lists[3].split(','),
    macC2S: lists[4].split(','),
    macS2C: lists[5].split(','),
    compressionC2S: lists[6].split(','),
    compressionS2C: lists[7].split(','),
  };
}

export function negotiate(clientList: string[], serverList: string[], category: string = 'algorithm'): string {
  for (const algo of clientList) {
    if (serverList.includes(algo)) return algo;
  }
  throw new Error(`No common ${category}: client=[${clientList.join(',')}] server=[${serverList.join(',')}]`);
}

/**
 * 解析 SSH_MSG_EXT_INFO（RFC 8301 §2.3）中的 server-sig-algs 扩展。
 * 仅提取 "server-sig-algs" 一个扩展，其余忽略；未找到时返回空数组。
 *
 * 包格式:
 *   byte      SSH_MSG_EXT_INFO (7)
 *   uint32    nr-extensions
 *   重复 nr-extensions 次:
 *     string  extension-name
 *     string  extension-value (binary)
 */
export function parseServerSigAlgs(payload: Uint8Array): string[] {
  let offset = 1; // 跳过 msg type

  if (offset + 4 > payload.length) throw new Error('ext-info: nr-extensions 越界');
  const nrExtensions = (payload[offset] << 24) | (payload[offset+1] << 16) |
                       (payload[offset+2] << 8) | payload[offset+3];
  offset += 4;

  // 防御性上限，避免恶意服务器声明超大计数触发长循环
  if (nrExtensions > 1024) throw new Error(`ext-info: nr-extensions 过大 (${nrExtensions})`);

  for (let i = 0; i < nrExtensions; i++) {
    if (offset + 4 > payload.length) throw new Error('ext-info: name-len 越界');
    const nameLen = (payload[offset] << 24) | (payload[offset+1] << 16) |
                    (payload[offset+2] << 8) | payload[offset+3];
    offset += 4;
    if (offset + nameLen > payload.length) throw new Error('ext-info: name 越界');
    const name = new TextDecoder().decode(payload.subarray(offset, offset + nameLen));
    offset += nameLen;

    if (offset + 4 > payload.length) throw new Error('ext-info: value-len 越界');
    const valueLen = (payload[offset] << 24) | (payload[offset+1] << 16) |
                     (payload[offset+2] << 8) | payload[offset+3];
    offset += 4;
    if (offset + valueLen > payload.length) throw new Error('ext-info: value 越界');
    const valueBytes = payload.subarray(offset, offset + valueLen);
    offset += valueLen;

    if (name === 'server-sig-algs') {
      // value 是 UTF-8 逗号分隔的算法列表
      const value = new TextDecoder().decode(valueBytes);
      return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
  }
  return [];
}

/**
 * 过滤掉 KEXINIT 算法列表中的 ext-info-* 伪算法名（RFC 8301 §2.1）。
 * 用于 negotiate 真正的 KEX algorithm 之前清理双方列表。
 */
export function filterExtInfo(list: string[]): string[] {
  return list.filter(a => !a.startsWith('ext-info-'));
}
