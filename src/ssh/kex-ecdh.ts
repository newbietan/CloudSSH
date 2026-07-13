import { SSH_MSG_KEX_ECDH_INIT } from '../types';
import { concat, readUint32, encodeString, toSSHMPInt } from './utils';

type ECDHSubtleCrypto = {
  generateKey(
    algorithm: { name: 'ECDH'; namedCurve: 'P-256' },
    extractable: boolean,
    keyUsages: string[]
  ): Promise<CryptoKeyPair>;
  exportKey(format: 'raw', key: CryptoKey): Promise<ArrayBuffer>;
  importKey(
    format: 'raw',
    keyData: ArrayBuffer | ArrayBufferView,
    algorithm: { name: 'ECDH'; namedCurve: 'P-256' },
    extractable: boolean,
    keyUsages: string[]
  ): Promise<CryptoKey>;
  deriveBits(
    algorithm: { name: 'ECDH'; public: CryptoKey },
    baseKey: CryptoKey,
    length: number
  ): Promise<ArrayBuffer>;
};

function ecdhSubtle(): ECDHSubtleCrypto {
  return crypto.subtle as unknown as ECDHSubtleCrypto;
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

export class ECDHKeyExchange {
  static async generateKeyPair(): Promise<CryptoKeyPair> {
    return ecdhSubtle().generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
  }

  static async exportRawPublicKey(keyPair: CryptoKeyPair): Promise<Uint8Array> {
    return new Uint8Array(
      await ecdhSubtle().exportKey('raw', keyPair.publicKey)
    );
  }

  static buildInit(clientRawPublicKey: Uint8Array): Uint8Array {
    return concat(
      new Uint8Array([SSH_MSG_KEX_ECDH_INIT]),
      encodeString(clientRawPublicKey)
    );
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
    const serverKey = await ecdhSubtle().importKey(
      'raw',
      serverRawPublicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const sharedBits = await ecdhSubtle().deriveBits(
      { name: 'ECDH', public: serverKey },
      privateKey,
      256
    );

    const sharedSecret = new Uint8Array(sharedBits);
    if (isAllZero(sharedSecret)) {
      throw new Error('ECDH key exchange failed: all-zero shared secret');
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
