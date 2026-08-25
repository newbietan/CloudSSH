import { SSH_MSG_KEX_ECDH_INIT } from '../types';
import { concat, encodeString, readUint32, toSSHMPInt } from './utils';

type X25519SubtleCrypto = {
  generateKey(
    algorithm: { name: 'X25519' },
    extractable: boolean,
    keyUsages: string[]
  ): Promise<CryptoKeyPair>;
  exportKey(format: 'raw', key: CryptoKey): Promise<ArrayBuffer>;
  importKey(
    format: 'raw',
    keyData: ArrayBuffer | ArrayBufferView,
    algorithm: { name: 'X25519' },
    extractable: boolean,
    keyUsages: string[]
  ): Promise<CryptoKey>;
  deriveBits(
    algorithm: { name: 'X25519'; public: CryptoKey },
    baseKey: CryptoKey,
    length: number
  ): Promise<ArrayBuffer>;
};

function x25519Subtle(): X25519SubtleCrypto {
  // SAFETY: Workers 运行时基于 WebCrypto 扩展曲线算法；类型缺官方声明，
  // 接口按运行时实际形状定义，此转换仅为补全 TS 签名
  return crypto.subtle as unknown as X25519SubtleCrypto;
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

export type Curve25519KeyPair = CryptoKeyPair;

export class Curve25519KeyExchange {
  static async generateKeyPair(): Promise<Curve25519KeyPair> {
    return x25519Subtle().generateKey({ name: 'X25519' }, true, ['deriveBits']);
  }

  static async exportRawPublicKey(keyPair: Curve25519KeyPair): Promise<Uint8Array> {
    return new Uint8Array(await x25519Subtle().exportKey('raw', keyPair.publicKey));
  }

  static buildInit(clientRawPublicKey: Uint8Array): Uint8Array {
    if (clientRawPublicKey.length !== 32) {
      throw new Error(`Invalid Curve25519 client public key length: ${clientRawPublicKey.length}`);
    }

    return concat(new Uint8Array([SSH_MSG_KEX_ECDH_INIT]), encodeString(clientRawPublicKey));
  }

  static parseReply(data: Uint8Array): {
    hostKey: Uint8Array;
    serverRawPublicKey: Uint8Array;
    signature: Uint8Array;
  } {
    let offset = 1;

    const hostKeyLen = readUint32(data, offset);
    offset += 4;
    const hostKey = data.slice(offset, offset + hostKeyLen);
    offset += hostKeyLen;

    const qSLen = readUint32(data, offset);
    offset += 4;
    const serverRawPublicKey = data.slice(offset, offset + qSLen);
    offset += qSLen;

    const sigLen = readUint32(data, offset);
    offset += 4;
    const signature = data.slice(offset, offset + sigLen);

    return { hostKey, serverRawPublicKey, signature };
  }

  static async computeSharedSecret(
    privateKey: CryptoKey,
    serverRawPublicKey: Uint8Array
  ): Promise<Uint8Array> {
    if (serverRawPublicKey.length !== 32) {
      throw new Error(`Invalid Curve25519 server public key length: ${serverRawPublicKey.length}`);
    }

    const serverKey = await x25519Subtle().importKey(
      'raw',
      serverRawPublicKey,
      { name: 'X25519' },
      false,
      []
    );

    const sharedSecret = new Uint8Array(
      await x25519Subtle().deriveBits({ name: 'X25519', public: serverKey }, privateKey, 256)
    );
    if (isAllZero(sharedSecret)) {
      throw new Error('Curve25519 key exchange failed: all-zero shared secret');
    }
    return toSSHMPInt(sharedSecret);
  }

  static async computeExchangeHash(
    clientVersion: string,
    serverVersion: string,
    clientKEXInit: Uint8Array,
    serverKEXInit: Uint8Array,
    hostKey: Uint8Array,
    clientRawPublicKey: Uint8Array,
    serverRawPublicKey: Uint8Array,
    sharedSecret: Uint8Array
  ): Promise<Uint8Array> {
    const v_c = encodeString(clientVersion);
    const v_s = encodeString(serverVersion);
    const i_c = encodeString(clientKEXInit);
    const i_s = encodeString(serverKEXInit);
    const k_s = encodeString(hostKey);
    const e = encodeString(clientRawPublicKey);
    const f = encodeString(serverRawPublicKey);
    const k = sharedSecret;

    const data = concat(v_c, v_s, i_c, i_s, k_s, e, f, k);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hashBuffer);
  }
}
