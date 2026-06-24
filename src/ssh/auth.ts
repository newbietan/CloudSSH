import { SSH_MSG_USERAUTH_REQUEST, SSH_MSG_USERAUTH_SUCCESS, SSH_MSG_USERAUTH_FAILURE, AuthResult } from '../types';
import { encodeString, concat, readUint32 } from './utils';

export class SSHAuth {
  static buildPasswordAuthRequest(
    username: string,
    password: string
  ): Uint8Array {
    const parts: Uint8Array[] = [
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('password'),
      new Uint8Array([0x00]),
      encodeString(password),
    ];

    return concat(...parts);
  }

  /**
   * Build a public key auth request for Ed25519 keys (RFC 4252 §7).
   * The signature covers: session_id_string || SSH_MSG_USERAUTH_REQUEST || user || service || "publickey" || TRUE || "ssh-ed25519" || pubkey_blob
   */
  static async buildPublicKeyAuthRequest(
    username: string,
    privateKeyPEM: string,
    sessionID: Uint8Array
  ): Promise<Uint8Array> {
    const { signingKey, publicKeyBlob } = await this.parseEd25519PrivateKey(privateKeyPEM);

    // Build the request body (without signature first)
    const requestBody = concat(
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('publickey'),
      new Uint8Array([0x01]), // TRUE = has signature
      encodeString('ssh-ed25519'),
      encodeString(publicKeyBlob),
    );

    // Data to sign: session_id_string || request_body
    const dataToSign = concat(encodeString(sessionID), requestBody);

    // Sign with Ed25519
    const rawSignature = new Uint8Array(await crypto.subtle.sign('Ed25519', signingKey, dataToSign));

    // SSH signature blob: string "ssh-ed25519" || string signature
    const signatureBlob = concat(
      encodeString('ssh-ed25519'),
      encodeString(rawSignature),
    );

    // Full auth packet: requestBody || string signature_blob
    return concat(requestBody, encodeString(signatureBlob));
  }

  /**
   * Parse an OpenSSH Ed25519 PEM private key.
   * Supports OPENSSH PRIVATE KEY format.
   */
  private static async parseEd25519PrivateKey(pem: string): Promise<{ signingKey: CryptoKey; publicKeyBlob: Uint8Array }> {
    const lines = pem.trim().split('\n');
    const b64 = lines.filter(l => !l.startsWith('-----')).join('');
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    // Parse OpenSSH format: "openssh-key-v1\0" magic
    const magic = 'openssh-key-v1\0';
    const magicBytes = new TextEncoder().encode(magic);
    if (raw.length < magicBytes.length) {
      throw new Error('私钥数据太短');
    }
    for (let i = 0; i < magicBytes.length; i++) {
      if (raw[i] !== magicBytes[i]) {
        throw new Error('不支持的私钥格式，仅支持 OpenSSH Ed25519 密钥');
      }
    }
    let offset = magicBytes.length;

    // ciphername
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：cipherLen 越界');
    const cipherLen = readUint32(raw, offset); offset += 4;
    if (offset + cipherLen > raw.length) throw new Error('私钥格式损坏：cipher 越界');
    const cipher = new TextDecoder().decode(raw.slice(offset, offset + cipherLen)); offset += cipherLen;
    if (cipher !== 'none') throw new Error('不支持加密的私钥，请使用 ssh-keygen -p 移除密码');

    // kdfname
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：kdfLen 越界');
    const kdfLen = readUint32(raw, offset); offset += 4;
    if (offset + kdfLen > raw.length) throw new Error('私钥格式损坏：kdf 越界');
    offset += kdfLen;
    // kdfoptions
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：kdfOptLen 越界');
    const kdfOptLen = readUint32(raw, offset); offset += 4;
    if (offset + kdfOptLen > raw.length) throw new Error('私钥格式损坏：kdfoptions 越界');
    offset += kdfOptLen;
    // number of keys
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：numKeys 越界');
    const numKeys = readUint32(raw, offset); offset += 4;
    if (numKeys !== 1) throw new Error('仅支持单密钥文件');

    // public key section
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：pubSecLen 越界');
    const pubSecLen = readUint32(raw, offset); offset += 4;
    if (offset + pubSecLen > raw.length) throw new Error('私钥格式损坏：pubSection 越界');
    offset += pubSecLen;

    // private key section
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：privSecLen 越界');
    const privSecLen = readUint32(raw, offset); offset += 4;
    if (offset + privSecLen > raw.length) throw new Error('私钥格式损坏：privSection 越界');
    const privSection = raw.slice(offset, offset + privSecLen);

    // Parse private section: checkint1, checkint2, keytype, pubkey, privkey, comment
    let po = 0;
    if (privSection.length < 8) throw new Error('私钥格式损坏：checkints 越界');
    po += 4; // checkint1
    po += 4; // checkint2

    // key type
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：keyTypeLen 越界');
    const ktLen = readUint32(privSection, po); po += 4;
    if (po + ktLen > privSection.length) throw new Error('私钥格式损坏：keyType 越界');
    const keyType = new TextDecoder().decode(privSection.slice(po, po + ktLen)); po += ktLen;
    if (keyType !== 'ssh-ed25519') throw new Error(`不支持的密钥类型: ${keyType}，仅支持 ssh-ed25519`);

    // public key (32 bytes)
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：pubKeyLen 越界');
    const pubKeyLen = readUint32(privSection, po); po += 4;
    if (po + pubKeyLen > privSection.length) throw new Error('私钥格式损坏：pubKey 越界');
    const pubKeyRaw = privSection.slice(po, po + pubKeyLen); po += pubKeyLen;

    // private key (64 bytes = 32 bytes seed + 32 bytes pubkey)
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：privKeyLen 越界');
    const privKeyLen = readUint32(privSection, po); po += 4;
    if (po + privKeyLen > privSection.length) throw new Error('私钥格式损坏：privKey 越界');
    const privKeyRaw = privSection.slice(po, po + privKeyLen);
    if (privKeyRaw.length < 32) throw new Error('私钥格式损坏：种子长度不足 32 字节');
    // Ed25519 seed is first 32 bytes
    const seed = privKeyRaw.slice(0, 32);

    // Import as PKCS8 for Web Crypto (build PKCS8 wrapper for Ed25519 seed)
    const pkcs8 = this.buildEd25519PKCS8(seed);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']
    );

    // Build SSH public key blob: string "ssh-ed25519" || string pubkey
    const publicKeyBlob = concat(
      encodeString('ssh-ed25519'),
      encodeString(pubKeyRaw),
    );

    return { signingKey, publicKeyBlob };
  }

  /**
   * Wrap a 32-byte Ed25519 seed into PKCS8 DER format for Web Crypto import.
   */
  private static buildEd25519PKCS8(seed: Uint8Array): Uint8Array {
    // PKCS8 structure for Ed25519:
    // SEQUENCE {
    //   INTEGER 0 (version)
    //   SEQUENCE { OID 1.3.101.112 (Ed25519) }
    //   OCTET STRING { OCTET STRING { seed } }
    // }
    const oid = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]); // OID 1.3.101.112
    const seedOctet = new Uint8Array([0x04, seed.length, ...seed]);
    const innerOctet = new Uint8Array([0x04, seedOctet.length, ...seedOctet]);
    const algoSeq = new Uint8Array([0x30, oid.length, ...oid]);
    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const totalLen = version.length + algoSeq.length + innerOctet.length;
    return new Uint8Array([0x30, totalLen, ...version, ...algoSeq, ...innerOctet]);
  }

  static handleResponse(payload: Uint8Array): AuthResult {
    const msgType = payload[0];

    switch (msgType) {
      case SSH_MSG_USERAUTH_SUCCESS:
        return { success: true };

      case SSH_MSG_USERAUTH_FAILURE: {
        const len = readUint32(payload, 1);
        const methods = new TextDecoder().decode(
          payload.slice(5, 5 + len)
        );
        return {
          success: false,
          allowedMethods: methods.split(','),
        };
      }

      default:
        throw new Error(`Unexpected auth message type: ${msgType}`);
    }
  }
}
