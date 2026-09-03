import { writeUint32 } from './utils';

function buildMacData(seqNum: number, packet: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + packet.length);
  writeUint32(data, 0, seqNum);
  data.set(packet, 4);
  return data;
}

export class SSHAESGCMCipher {
  private key: CryptoKey | null = null;
  private iv: Uint8Array;
  private rawKey: Uint8Array;

  constructor(rawKey: Uint8Array, iv: Uint8Array) {
    // Copy the IV so we own it; this is the mutable nonce state
    this.iv = new Uint8Array(iv);
    this.rawKey = rawKey;
  }

  async init(): Promise<void> {
    this.key = await crypto.subtle.importKey(
      'raw',
      this.rawKey,
      { name: 'AES-GCM', length: this.rawKey.length * 8 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Increment the 64-bit invocation counter stored in IV bytes [4..11]
   * using big-endian carry-over logic, per RFC 5647 §7.1.
   */
  private incIV(): void {
    for (let i = 11; i >= 4; i--) {
      this.iv[i]++;
      if (this.iv[i] !== 0) {
        break;
      }
    }
  }

  private getAlgorithm(aad?: Uint8Array): Record<string, unknown> {
    const algorithm: Record<string, unknown> = {
      name: 'AES-GCM',
      iv: this.iv,
      tagLength: 128,
    };
    if (aad) {
      algorithm.additionalData = aad;
    }
    return algorithm;
  }

  async encrypt(
    plaintext: Uint8Array,
    _seqNum?: number,
    aad?: Uint8Array,
    _commit: boolean = true
  ): Promise<Uint8Array> {
    if (!this.key) throw new Error('Cipher not initialized');
    const algorithm = this.getAlgorithm(aad);

    // SAFETY: getAlgorithm 返回的算法对象仅含 AesGcmParams 支持的分段；
    // WebCrypto 类型签名过窄，运行时与 TS 均接受该形状
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        algorithm as unknown as SubtleCryptoEncryptAlgorithm,
        this.key,
        plaintext
      )
    );

    this.incIV();
    return encrypted;
  }

  async decrypt(
    ciphertext: Uint8Array,
    _seqNum?: number,
    aad?: Uint8Array,
    _commit: boolean = true
  ): Promise<Uint8Array | null> {
    if (!this.key) throw new Error('Cipher not initialized');
    const algorithm = this.getAlgorithm(aad);

    try {
      // SAFETY: getAlgorithm 返回的算法对象仅含 AesGcmParams 支持的分段；
      // WebCrypto 类型签名过窄，运行时与 TS 均接受该形状
      const decrypted = new Uint8Array(
        await crypto.subtle.decrypt(
          algorithm as unknown as SubtleCryptoEncryptAlgorithm,
          this.key,
          ciphertext
        )
      );
      this.incIV();
      return decrypted;
    } catch (e) {
      console.error(
        '[CRYPTO] Decrypt failed, ciphertextLen:',
        ciphertext?.length,
        'error:',
        e instanceof Error ? e.message : String(e)
      );
      return null;
    }
  }
}

export class SSHAESCTRCipher {
  private key: CryptoKey | null = null;
  private counter: Uint8Array;
  private rawKey: Uint8Array;

  constructor(rawKey: Uint8Array, iv: Uint8Array) {
    if (iv.length !== 16) {
      throw new Error(`AES-CTR requires a 16-byte IV, got ${iv.length}`);
    }
    this.counter = new Uint8Array(iv);
    this.rawKey = rawKey;
  }

  async init(): Promise<void> {
    this.key = await crypto.subtle.importKey(
      'raw',
      this.rawKey,
      { name: 'AES-CTR', length: this.rawKey.length * 8 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  private incCounter(blocks: number): void {
    let carry = blocks;
    for (let i = 15; i >= 0 && carry > 0; i--) {
      const add = carry % 256;
      const sum = this.counter[i] + add;
      this.counter[i] = sum & 0xff;
      carry = Math.floor(carry / 256) + (sum >>> 8);
    }
  }

  async encrypt(
    plaintext: Uint8Array,
    _seqNum?: number,
    _aad?: Uint8Array,
    commit: boolean = true
  ): Promise<Uint8Array> {
    if (!this.key) throw new Error('Cipher not initialized');
    const counter = new Uint8Array(this.counter);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-CTR', counter, length: 128 } as SubtleCryptoEncryptAlgorithm,
        this.key,
        plaintext
      )
    );
    if (commit) {
      this.incCounter(Math.ceil(plaintext.length / 16));
    }
    return encrypted;
  }

  async decrypt(
    ciphertext: Uint8Array,
    _seqNum?: number,
    _aad?: Uint8Array,
    commit: boolean = true
  ): Promise<Uint8Array | null> {
    if (!this.key) throw new Error('Cipher not initialized');
    const counter = new Uint8Array(this.counter);
    try {
      const decrypted = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter, length: 128 } as SubtleCryptoEncryptAlgorithm,
          this.key,
          ciphertext
        )
      );
      if (commit) {
        this.incCounter(Math.ceil(ciphertext.length / 16));
      }
      return decrypted;
    } catch (e) {
      console.error(
        '[CRYPTO] AES-CTR decrypt failed, ciphertextLen:',
        ciphertext?.length,
        'error:',
        e instanceof Error ? e.message : String(e)
      );
      return null;
    }
  }
}

export class SSHHMAC {
  private key: CryptoKey | null = null;
  private rawKey: Uint8Array;
  private hash: 'SHA-1' | 'SHA-256' | 'SHA-512';
  readonly length: number;

  constructor(algorithm: string, rawKey: Uint8Array) {
    this.rawKey = rawKey;
    if (algorithm === 'hmac-sha1') {
      this.hash = 'SHA-1';
      this.length = 20;
    } else if (algorithm === 'hmac-sha2-256') {
      this.hash = 'SHA-256';
      this.length = 32;
    } else if (algorithm === 'hmac-sha2-512') {
      this.hash = 'SHA-512';
      this.length = 64;
    } else {
      throw new Error(`Unsupported MAC algorithm: ${algorithm}`);
    }
  }

  async init(): Promise<void> {
    this.key = await crypto.subtle.importKey(
      'raw',
      this.rawKey,
      { name: 'HMAC', hash: this.hash },
      false,
      ['sign', 'verify']
    );
  }

  async sign(packet: Uint8Array, seqNum: number): Promise<Uint8Array> {
    if (!this.key) throw new Error('MAC not initialized');
    return new Uint8Array(await crypto.subtle.sign('HMAC', this.key, buildMacData(seqNum, packet)));
  }

  async verify(packet: Uint8Array, seqNum: number, expected: Uint8Array): Promise<boolean> {
    if (!this.key) throw new Error('MAC not initialized');
    return crypto.subtle.verify('HMAC', this.key, expected, buildMacData(seqNum, packet));
  }
}

export const REKEY_THRESHOLD = 1 << 30;

export function shouldRekey(seqNum: number): boolean {
  return seqNum >= REKEY_THRESHOLD;
}

/**
 * 将 Uint8Array 编码为 base64url 字符串，去除前导零字节（用于 JWK mpint 格式）。
 */
export function base64UrlEncodeUnsigned(buffer: Uint8Array): string {
  let start = 0;
  while (start < buffer.length - 1 && buffer[start] === 0x00) {
    start++;
  }
  let binary = '';
  for (let i = start; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 将 SSH ECDSA 签名（包含 r 和 s 两个 mpint 格式字符串）转换为 Web Crypto 所需的原始拼接字节。
 */
export function convertSSHECDSASig(sshSig: Uint8Array, coordBytes: number = 32): Uint8Array {
  let offset = 0;
  const rLen =
    (sshSig[offset] << 24) |
    (sshSig[offset + 1] << 16) |
    (sshSig[offset + 2] << 8) |
    sshSig[offset + 3];
  offset += 4;
  let r = sshSig.subarray(offset, offset + rLen);
  offset += rLen;
  const sLen =
    (sshSig[offset] << 24) |
    (sshSig[offset + 1] << 16) |
    (sshSig[offset + 2] << 8) |
    sshSig[offset + 3];
  offset += 4;
  let s = sshSig.subarray(offset, offset + sLen);

  // Strip leading zero bytes (mpint sign extension)
  if (r.length > coordBytes && r[0] === 0) r = r.subarray(1);
  if (s.length > coordBytes && s[0] === 0) s = s.subarray(1);

  // Pad to coordBytes each (P-256=32, P-384=48, P-521=66)
  const result = new Uint8Array(coordBytes * 2);
  result.set(r, coordBytes - r.length);
  result.set(s, coordBytes * 2 - s.length);
  return result;
}
