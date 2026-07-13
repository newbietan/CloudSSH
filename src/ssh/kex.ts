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
      SUPPORTED_KEX_ALGORITHMS.join(','),
      'ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256,ssh-rsa',
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
