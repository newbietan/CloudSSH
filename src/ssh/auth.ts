import { SSH_MSG_USERAUTH_REQUEST, SSH_MSG_USERAUTH_SUCCESS, SSH_MSG_USERAUTH_FAILURE, AuthResult } from '../types';
import { encodeString, concat, readUint32 } from './utils';

// SSH key type constants
const SSH_ED25519 = 'ssh-ed25519';
const SSH_RSA = 'ssh-rsa';
const ECDSA_SHA2_NISTP256 = 'ecdsa-sha2-nistp256';
const ECDSA_SHA2_NISTP384 = 'ecdsa-sha2-nistp384';
const ECDSA_SHA2_NISTP521 = 'ecdsa-sha2-nistp521';

// Web Crypto algorithm names
const ED25519_ALGO = 'Ed25519';
const RSA_ALGO = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const ECDSA_P256_ALGO = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDSA_P384_ALGO = { name: 'ECDSA', namedCurve: 'P-384' };
const ECDSA_P521_ALGO = { name: 'ECDSA', namedCurve: 'P-521' };

interface ParsedKey {
  signingKey: CryptoKey;
  /** RSA key 的 PKCS8 原始字节。WebCrypto 实现可能会在 import 时把
   *  RSASSA-PKCS1-v1_5 的 hash 绑定到 key 上，导致后续 sign 时再传其它 hash
   *  被忽略（Node 上观察到的行为）。为了让 RSA 既能签 SHA-256 又能签 SHA-512，
   *  我们在每次签名时用对应 hash 的 algorithm 对象重新 import 一次。
   *  Ed25519 与 ECDSA 不受影响（hash 在 sign() 调用时直接传入且 import 时不绑定）。*/
  rsaPkcs8?: Uint8Array;
  publicKeyBlob: Uint8Array;
  keyType: string;
}

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
   * Build a public key auth request for any supported key type (RFC 4252 §7).
   * Automatically detects key type from the private key PEM.
   *
   * 对于 RSA：RFC 8332 要求 USERAUTH_REQUEST 的 public key algorithm name 字段与
   * 签名 blob 内的 signature algorithm name 字段必须一致。公钥 blob 内部类型仍保持
   * `ssh-rsa`，但外层两个字段根据 `serverSigAlgs` 协商结果选择：
   *   - `rsa-sha2-512`（优先）
   *   - `rsa-sha2-256`
   *   - `ssh-rsa`（SHA-1，仅当 `allowLegacyRsaSha1=true` 且 server 显式支持时）
   * 默认（未提供 serverSigAlgs）使用 `rsa-sha2-256`，绝不再静默降级到 SHA-1。
   *
   * @param username            SSH 用户名
   * @param privateKeyPEM       OpenSSH 私钥 PEM
   * @param sessionID           会话 ID（用于签名）
   * @param serverSigAlgs       服务端 SSH_MSG_EXT_INFO 的 server-sig-algs 列表
   * @param allowLegacyRsaSha1  是否允许 ssh-rsa(SHA-1) 兼容
   */
  static async buildPublicKeyAuthRequest(
    username: string,
    privateKeyPEM: string,
    sessionID: Uint8Array,
    serverSigAlgs?: string[],
    allowLegacyRsaSha1: boolean = false,
  ): Promise<Uint8Array> {
    const { signingKey, publicKeyBlob, keyType, rsaPkcs8 } = await this.parsePrivateKey(privateKeyPEM);

    // 确定 request / signature 外层算法名（公钥 blob 内部类型不变）
    let requestAlgo = keyType;
    let signatureAlgo = keyType;

    if (keyType === SSH_RSA) {
      const chosen = this.selectRsaSigAlgorithm(serverSigAlgs, allowLegacyRsaSha1);
      requestAlgo = chosen;
      signatureAlgo = chosen;
    }

    // Build the request body (without signature first)
    const requestBody = concat(
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('publickey'),
      new Uint8Array([0x01]), // TRUE = has signature
      encodeString(requestAlgo),
      encodeString(publicKeyBlob),
    );

    // Data to sign: session_id_string || request_body
    const dataToSign = concat(encodeString(sessionID), requestBody);

    // Sign based on key type
    let rawSignature: Uint8Array;
    let signatureBlob: Uint8Array;

    if (keyType === SSH_ED25519) {
      rawSignature = new Uint8Array(await crypto.subtle.sign(ED25519_ALGO, signingKey, dataToSign));
      signatureBlob = concat(
        encodeString(SSH_ED25519),
        encodeString(rawSignature),
      );
    } else if (keyType === SSH_RSA) {
      const hash = signatureAlgo === 'rsa-sha2-512' ? 'SHA-512'
                 : signatureAlgo === 'ssh-rsa'        ? 'SHA-1'
                 : 'SHA-256';
      // 某些 WebCrypto 实现会在 importKey 时把 RSASSA-PKCS1-v1_5 的 hash 绑定到
      // CryptoKey，导致后续 sign 时即使传不同 hash 也被忽略（用 SHA-256 import
      // 的 key 试签 SHA-512 会得到 SHA-256 签名）。这里在 hash 与 import 时 hash
      // 不一致的情况下重新 import 一次。
      let sigKey = signingKey;
      if (hash !== 'SHA-256' && rsaPkcs8) {
        sigKey = await crypto.subtle.importKey(
          'pkcs8', rsaPkcs8,
          { name: 'RSASSA-PKCS1-v1_5', hash },
          false, ['sign'],
        );
      }
      rawSignature = new Uint8Array(
        await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5', hash }, sigKey, dataToSign)
      );
      signatureBlob = concat(
        encodeString(signatureAlgo),
        encodeString(rawSignature),
      );
    } else if (keyType.startsWith('ecdsa-sha2-')) {
      // RFC 5656 §6.2.1: 曲线 → 哈希映射 exhaustive
      const hash = this.ecdsaHashForCurve(keyType);
      const sigBytes = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash },
        signingKey,
        dataToSign
      ));
      // 运行时检测 WebCrypto 返回格式（DER 或 raw r||s），不预设
      const sshSignature = this.ecdsaWebCryptoToSSH(sigBytes, this.ecdsaCoordBytes(keyType));
      signatureBlob = concat(
        encodeString(keyType),
        encodeString(sshSignature),
      );
    } else {
      throw new Error(`不支持的密钥类型: ${keyType}`);
    }

    // Full auth packet: requestBody || string signature_blob
    return concat(requestBody, encodeString(signatureBlob));
  }

  /**
   * 根据服务端 server-sig-algs 与本地策略选择 RSA 签名算法。
   * 优先 rsa-sha2-512，其次 rsa-sha2-256；ssh-rsa(SHA-1) 仅在显式启用且服务器支持时使用。
   * 服务器能力与本地策略无交集时抛 fatal `no_supported_rsa_signature_algorithm`。
   */
  private static selectRsaSigAlgorithm(
    serverSigAlgs: string[] | undefined,
    allowLegacyRsaSha1: boolean,
  ): string {
    // 本地策略：优先 512 → 256；SHA-1 可选
    const localOrder = allowLegacyRsaSha1
      ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
      : ['rsa-sha2-512', 'rsa-sha2-256'];

    if (!serverSigAlgs || serverSigAlgs.length === 0) {
      // 未收到 ext-info：默认 rsa-sha2-256（绝大多数支持 RSA-SHA2 的服务器都接受）
      return 'rsa-sha2-256';
    }

    const serverSet = new Set(serverSigAlgs);
    for (const algo of localOrder) {
      if (serverSet.has(algo)) return algo;
    }
    throw new Error(
      `no_supported_rsa_signature_algorithm: server=[${serverSigAlgs.join(',')}] local=[${localOrder.join(',')}]`
    );
  }

  /**
   * RFC 5656 §6.2.1: ECDSA 曲线 → 哈希算法 exhaustive 映射。
   */
  private static ecdsaHashForCurve(keyType: string): 'SHA-256' | 'SHA-384' | 'SHA-512' {
    switch (keyType) {
      case ECDSA_SHA2_NISTP256: return 'SHA-256';  // 坐标 32 字节
      case ECDSA_SHA2_NISTP384: return 'SHA-384';  // 坐标 48 字节
      case ECDSA_SHA2_NISTP521: return 'SHA-512';  // 坐标 66 字节
    }
    // exhaustive: 走到这里说明 keyType 不是三种受支持曲线之一
    throw new Error(`unsupported ECDSA key type: ${keyType}`);
  }

  /**
   * ECDSA 曲线对应的单坐标字节长度（用于 raw r||s 编码）。
   */
  private static ecdsaCoordBytes(keyType: string): number {
    switch (keyType) {
      case ECDSA_SHA2_NISTP256: return 32;
      case ECDSA_SHA2_NISTP384: return 48;
      case ECDSA_SHA2_NISTP521: return 66;
    }
    throw new Error(`unsupported ECDSA key type: ${keyType}`);
  }

  /**
   * 把 WebCrypto ECDSA 签名输出转换为 SSH 的 `string(r) || string(s)` 格式。
   * 运行时检测输入是 DER SEQUENCE 还是 raw `r||s`，不预设 Worker 实现行为。
   */
  private static ecdsaWebCryptoToSSH(sigBytes: Uint8Array, coordBytes: number): Uint8Array {
    if (sigBytes.length < 2) throw new Error('ECDSA 签名长度过短');

    if (sigBytes[0] === 0x30) {
      // DER SEQUENCE
      return this.convertECDSADERToSSH(sigBytes);
    }

    // raw r || s（固定长度 2 * coordBytes）
    if (sigBytes.length !== coordBytes * 2) {
      throw new Error(`ECDSA raw 签名长度不匹配: 期望 ${coordBytes * 2}，实际 ${sigBytes.length}`);
    }
    const r = sigBytes.subarray(0, coordBytes);
    const s = sigBytes.subarray(coordBytes);
    // 转成 mpint（去掉前导 0，最高位为 1 时补 0）
    return concat(this.sshMPInt(r), this.sshMPInt(s));
  }

  /**
   * Parse an OpenSSH private key and detect its type.
   */
  private static async parsePrivateKey(pem: string): Promise<ParsedKey> {
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
        throw new Error('不支持的私钥格式，仅支持 OpenSSH 格式');
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

    // Parse private section: checkint1, checkint2, keytype, ...
    let po = 0;
    if (privSection.length < 8) throw new Error('私钥格式损坏：checkints 越界');
    po += 4; // checkint1
    po += 4; // checkint2

    // key type
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：keyTypeLen 越界');
    const ktLen = readUint32(privSection, po); po += 4;
    if (po + ktLen > privSection.length) throw new Error('私钥格式损坏：keyType 越界');
    const keyType = new TextDecoder().decode(privSection.slice(po, po + ktLen)); po += ktLen;

    // Parse based on key type
    if (keyType === SSH_ED25519) {
      return this.parseEd25519Key(privSection, po);
    } else if (keyType === SSH_RSA) {
      return this.parseRSAKey(privSection, po);
    } else if (keyType.startsWith('ecdsa-sha2-')) {
      return this.parseECDSAKey(privSection, po, keyType);
    } else {
      throw new Error(`不支持的密钥类型: ${keyType}`);
    }
  }

  /**
   * Parse Ed25519 private key from OpenSSH format.
   */
  private static async parseEd25519Key(privSection: Uint8Array, offset: number): Promise<ParsedKey> {
    let po = offset;

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

    const seed = privKeyRaw.slice(0, 32);

    const pkcs8 = this.buildEd25519PKCS8(seed);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: ED25519_ALGO }, false, ['sign']
    );

    const publicKeyBlob = concat(
      encodeString(SSH_ED25519),
      encodeString(pubKeyRaw),
    );

    return { signingKey, publicKeyBlob, keyType: SSH_ED25519 };
  }

  /**
   * Parse RSA private key from OpenSSH format.
   */
  private static async parseRSAKey(privSection: Uint8Array, offset: number): Promise<ParsedKey> {
    let po = offset;

    const readMPINT = (): Uint8Array => {
      if (po + 4 > privSection.length) throw new Error('私钥格式损坏：MPINT 越界');
      const len = readUint32(privSection, po); po += 4;
      if (po + len > privSection.length) throw new Error('私钥格式损坏：MPINT 数据越界');
      const data = privSection.slice(po, po + len); po += len;
      if (data.length > 1 && data[0] === 0) {
        return data.slice(1);
      }
      return data;
    };

    const n = readMPINT();
    const e = readMPINT();
    const d = readMPINT();
    const iqmp = readMPINT();
    const p = readMPINT();
    const q = readMPINT();

    const pkcs8 = this.buildRSAPKCS8(n, e, d, p, q, iqmp);

    // 注意：RSASSA-PKCS1-v1_5 在 importKey 时把 hash 绑定到 CryptoKey 上，
    // 后续 sign 时即使传不同 hash 也会被某些 WebCrypto 实现忽略。
    // 因此这里用一个固定 hash(任意)先导入，供 build 在使用 SHA-256 路径时复用；
    // 用 SHA-512 时会基于 rsaPkcs8 字段重新 import。
    const signingKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8, RSA_ALGO, false, ['sign']
    );

    const publicKeyBlob = concat(
      encodeString(SSH_RSA),
      this.sshMPInt(e),
      this.sshMPInt(n),
    );

    return { signingKey, rsaPkcs8: pkcs8, publicKeyBlob, keyType: SSH_RSA };
  }

  /**
   * Parse ECDSA private key from OpenSSH format.
   */
  private static async parseECDSAKey(privSection: Uint8Array, offset: number, keyType: string): Promise<ParsedKey> {
    let po = offset;

    let namedCurve: string;
    let algo: any;

    if (keyType === ECDSA_SHA2_NISTP256) {
      namedCurve = 'P-256';
      algo = ECDSA_P256_ALGO;
    } else if (keyType === ECDSA_SHA2_NISTP384) {
      namedCurve = 'P-384';
      algo = ECDSA_P384_ALGO;
    } else if (keyType === ECDSA_SHA2_NISTP521) {
      namedCurve = 'P-521';
      algo = ECDSA_P521_ALGO;
    } else {
      throw new Error(`不支持的 ECDSA 曲线: ${keyType}`);
    }

    // curve name
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：curveLen 越界');
    const curveLen = readUint32(privSection, po); po += 4;
    if (po + curveLen > privSection.length) throw new Error('私钥格式损坏：curve 越界');
    const curve = new TextDecoder().decode(privSection.slice(po, po + curveLen)); po += curveLen;

    const expectedCurve = namedCurve.replace('P-', 'nistp');
    if (curve !== expectedCurve) {
      throw new Error(`曲线不匹配: 期望 ${expectedCurve}，实际 ${curve}`);
    }

    // public key
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：pubKeyLen 越界');
    const pubKeyLen = readUint32(privSection, po); po += 4;
    if (po + pubKeyLen > privSection.length) throw new Error('私钥格式损坏：pubKey 越界');
    const pubKeyRaw = privSection.slice(po, po + pubKeyLen); po += pubKeyLen;

    // private key
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：privKeyLen 越界');
    const privKeyLen = readUint32(privSection, po); po += 4;
    if (po + privKeyLen > privSection.length) throw new Error('私钥格式损坏：privKey 越界');
    const privKeyRaw = privSection.slice(po, po + privKeyLen);

    const pkcs8 = this.buildECDSAPKCS8(namedCurve, privKeyRaw);

    const signingKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8, algo, false, ['sign']
    );

    const publicKeyBlob = concat(
      encodeString(keyType),
      encodeString(curve),
      encodeString(pubKeyRaw),
    );

    return { signingKey, publicKeyBlob, keyType };
  }

  /**
   * Build PKCS#8 DER format for Ed25519 seed.
   */
  private static buildEd25519PKCS8(seed: Uint8Array): Uint8Array {
    const oid = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]);
    const seedOctet = new Uint8Array([0x04, seed.length, ...seed]);
    const innerOctet = new Uint8Array([0x04, seedOctet.length, ...seedOctet]);
    const algoSeq = new Uint8Array([0x30, oid.length, ...oid]);
    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const totalLen = version.length + algoSeq.length + innerOctet.length;
    return new Uint8Array([0x30, totalLen, ...version, ...algoSeq, ...innerOctet]);
  }

  /**
   * Build PKCS#8 DER format for RSA private key.
   */
  private static buildRSAPKCS8(
    n: Uint8Array, e: Uint8Array, d: Uint8Array,
    p: Uint8Array, q: Uint8Array, iqmp: Uint8Array
  ): Uint8Array {
    const pkcs1 = this.buildRSAPKCS1(n, e, d, p, q, iqmp);

    const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
    const nullParam = new Uint8Array([0x05, 0x00]);
    const algoSeq = this.buildDERSequence(concat(rsaOid, nullParam));

    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const privKeyOctet = this.buildDEROctetString(pkcs1);

    return this.buildDERSequence(concat(version, algoSeq, privKeyOctet));
  }

  /**
   * Build PKCS#1 RSAPrivateKey DER format.
   */
  private static buildRSAPKCS1(
    n: Uint8Array, e: Uint8Array, d: Uint8Array,
    p: Uint8Array, q: Uint8Array, iqmp: Uint8Array
  ): Uint8Array {
    const version = this.buildDERInteger(new Uint8Array([0]));
    const modulus = this.buildDERInteger(n);
    const publicExp = this.buildDERInteger(e);
    const privateExp = this.buildDERInteger(d);
    const prime1 = this.buildDERInteger(p);
    const prime2 = this.buildDERInteger(q);

    const pMinus1 = this.bigIntSubtract(p, new Uint8Array([1]));
    const qMinus1 = this.bigIntSubtract(q, new Uint8Array([1]));
    const exponent1 = this.buildDERInteger(this.bigIntMod(d, pMinus1));
    const exponent2 = this.buildDERInteger(this.bigIntMod(d, qMinus1));
    const coefficient = this.buildDERInteger(iqmp);

    return this.buildDERSequence(
      concat(version, modulus, publicExp, privateExp, prime1, prime2, exponent1, exponent2, coefficient)
    );
  }

  /**
   * Build PKCS#8 DER format for ECDSA private key.
   */
  private static buildECDSAPKCS8(namedCurve: string, privateKey: Uint8Array): Uint8Array {
    let curveOid: Uint8Array;
    if (namedCurve === 'P-256') {
      curveOid = new Uint8Array([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
    } else if (namedCurve === 'P-384') {
      curveOid = new Uint8Array([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22]);
    } else if (namedCurve === 'P-521') {
      curveOid = new Uint8Array([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23]);
    } else {
      throw new Error(`不支持的曲线: ${namedCurve}`);
    }

    const ecVersion = this.buildDERInteger(new Uint8Array([1]));
    const ecPrivKeyOctet = this.buildDEROctetString(privateKey);
    const parameters = new Uint8Array([0xa0, curveOid.length, ...curveOid]);
    const ecPrivateKey = this.buildDERSequence(concat(ecVersion, ecPrivKeyOctet, parameters));

    const ecOid = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
    const algoSeq = this.buildDERSequence(concat(ecOid, curveOid));

    const pkcs8Version = this.buildDERInteger(new Uint8Array([0]));
    const privateKeyOctet = this.buildDEROctetString(ecPrivateKey);

    return this.buildDERSequence(concat(pkcs8Version, algoSeq, privateKeyOctet));
  }

  /**
   * Build DER INTEGER.
   */
  private static buildDERInteger(value: Uint8Array): Uint8Array {
    let data = value;
    if (data.length > 0 && (data[0] & 0x80) !== 0) {
      data = concat(new Uint8Array([0]), data);
    }
    while (data.length > 1 && data[0] === 0 && data[1] === 0) {
      data = data.slice(1);
    }

    return concat(
      new Uint8Array([0x02]),
      this.encodeDERLength(data.length),
      data
    );
  }

  /**
   * Build DER OCTET STRING.
   */
  private static buildDEROctetString(data: Uint8Array): Uint8Array {
    return concat(
      new Uint8Array([0x04]),
      this.encodeDERLength(data.length),
      data
    );
  }

  /**
   * Build DER SEQUENCE.
   */
  private static buildDERSequence(data: Uint8Array): Uint8Array {
    return concat(
      new Uint8Array([0x30]),
      this.encodeDERLength(data.length),
      data
    );
  }

  /**
   * Encode DER length.
   */
  private static encodeDERLength(length: number): Uint8Array {
    if (length < 0x80) {
      return new Uint8Array([length]);
    } else if (length < 0x100) {
      return new Uint8Array([0x81, length]);
    } else if (length < 0x10000) {
      return new Uint8Array([0x82, (length >> 8) & 0xff, length & 0xff]);
    } else {
      throw new Error('DER 长度超出范围');
    }
  }

  /**
   * Convert ECDSA DER signature to SSH format (r || s).
   */
  private static convertECDSADERToSSH(derSignature: Uint8Array): Uint8Array {
    let offset = 0;

    if (derSignature[offset] !== 0x30) throw new Error('无效的 DER 签名格式');
    offset++;

    if (derSignature[offset] < 0x80) {
      offset++;
    } else {
      const lenBytes = derSignature[offset] & 0x7f;
      offset += 1 + lenBytes;
    }

    if (derSignature[offset] !== 0x02) throw new Error('无效的 DER 签名格式');
    offset++;

    let rLen: number;
    if (derSignature[offset] < 0x80) {
      rLen = derSignature[offset];
      offset++;
    } else {
      const lenBytes = derSignature[offset] & 0x7f;
      rLen = 0;
      for (let i = 0; i < lenBytes; i++) {
        rLen = (rLen << 8) | derSignature[offset + 1 + i];
      }
      offset += 1 + lenBytes;
    }

    let r = derSignature.slice(offset, offset + rLen);
    offset += rLen;

    if (derSignature[offset] !== 0x02) throw new Error('无效的 DER 签名格式');
    offset++;

    let sLen: number;
    if (derSignature[offset] < 0x80) {
      sLen = derSignature[offset];
      offset++;
    } else {
      const lenBytes = derSignature[offset] & 0x7f;
      sLen = 0;
      for (let i = 0; i < lenBytes; i++) {
        sLen = (sLen << 8) | derSignature[offset + 1 + i];
      }
      offset += 1 + lenBytes;
    }

    let s = derSignature.slice(offset, offset + sLen);

    while (r.length > 1 && r[0] === 0) r = r.slice(1);
    while (s.length > 1 && s[0] === 0) s = s.slice(1);

    return concat(
      encodeString(r),
      encodeString(s)
    );
  }

  /**
   * Encode MPINT in SSH format.
   */
  private static sshMPInt(value: Uint8Array): Uint8Array {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) {
      start++;
    }
    const significant = value.subarray(start);

    const needsLeadingZero = significant.length > 0 && (significant[0] & 0x80) !== 0;
    const data = needsLeadingZero
      ? concat(new Uint8Array([0]), significant)
      : significant;

    return encodeString(data);
  }

  /**
   * Subtract two big integers (big-endian).
   */
  private static bigIntSubtract(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length);
    let borrow = 0;

    for (let i = a.length - 1; i >= 0; i--) {
      const aByte = a[i];
      const bByte = i >= a.length - b.length ? b[b.length - (a.length - i)] : 0;

      let diff = aByte - bByte - borrow;
      if (diff < 0) {
        diff += 256;
        borrow = 1;
      } else {
        borrow = 0;
      }
      result[i] = diff;
    }

    let start = 0;
    while (start < result.length - 1 && result[start] === 0) {
      start++;
    }
    return result.slice(start);
  }

  /**
   * Calculate a mod m for big integers.
   */
  private static bigIntMod(a: Uint8Array, m: Uint8Array): Uint8Array {
    const toBigInt = (bytes: Uint8Array): bigint => {
      let n = 0n;
      for (const b of bytes) n = (n << 8n) | BigInt(b);
      return n;
    };
    const r = toBigInt(a) % toBigInt(m);
    const hex = r.toString(16).padStart(2, '0');
    const padded = hex.length % 2 ? '0' + hex : hex;
    const out = new Uint8Array(padded.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    return out;
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
