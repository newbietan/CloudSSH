import {
  type AuthResult,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_INFO_REQUEST,
  SSH_MSG_USERAUTH_INFO_RESPONSE,
  SSH_MSG_USERAUTH_REQUEST,
  SSH_MSG_USERAUTH_SUCCESS,
} from '../types';
import { concat, encodeString, encodeUint32, readUint32 } from './utils';
import { type EcNamedCurve, type RsaComponents, parsePkcs1Rsa, parsePkcs8, parseSec1Ec } from './pkcs';

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

// 私钥导入时的误贴/不支持的封装特征（详见 extractPrivateMaterial）
const RE_CERTIFICATE = /-----BEGIN CERTIFICATE-----/;
const RE_PUBLIC_KEY_PEM = /-----BEGIN [A-Z0-9 ]*PUBLIC KEY-----/;
const RE_OPENSSH_PUBLIC_LINE =
  /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521))[ \t]+[A-Za-z0-9+/=]{20,}/m;
const RE_PUTTY_PPK = /PuTTY-User-Key-File/;
const RE_TRADITIONAL_ENCRYPTED = /Proc-Type:\s*4\s*,\s*ENCRYPTED/i;
const RE_ANY_BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/;

/** 解码 JWK 的 base64url 字段（x/y）。 */
function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * 解码 PEM 正文 Base64：合并所有空白行（容忍 CRLF/缩进），
 * 非法字符给出友好错误而不是浏览器原生 InvalidCharacterError。
 */
function decodePemBase64(body: string): Uint8Array {
  const b64 = body
    .split(/\s+/)
    .filter(Boolean)
    .join('');
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('私钥内容损坏：包含非 Base64 字符，请重新完整复制密钥');
  }
}

// RFC 4256 fields are controlled by the SSH server. Keep their decoded size
// bounded before forwarding them to the browser.
const MAX_KEYBOARD_INTERACTIVE_PACKET_BYTES = 256 * 1024;
const MAX_KEYBOARD_INTERACTIVE_NAME_BYTES = 16 * 1024;
const MAX_KEYBOARD_INTERACTIVE_INSTRUCTION_BYTES = 64 * 1024;
const MAX_KEYBOARD_INTERACTIVE_LANGUAGE_BYTES = 1024;
const MAX_KEYBOARD_INTERACTIVE_PROMPTS = 32;
const MAX_KEYBOARD_INTERACTIVE_PROMPT_BYTES = 16 * 1024;
const MAX_KEYBOARD_INTERACTIVE_RESPONSE_BYTES = 64 * 1024;

export interface KeyboardInteractivePrompt {
  text: string;
  echo: boolean;
}

export interface KeyboardInteractiveInfoRequest {
  name: string;
  instruction: string;
  language: string;
  prompts: KeyboardInteractivePrompt[];
}

interface DecodedSSHString {
  value: string;
  nextOffset: number;
}

function decodeSSHStringStrict(
  payload: Uint8Array,
  offset: number,
  field: string,
  maxBytes: number
): DecodedSSHString {
  if (offset > payload.length - 4) {
    throw new Error(`Malformed keyboard-interactive info request: truncated ${field} length`);
  }

  const length = readUint32(payload, offset);
  if (length > maxBytes) {
    throw new Error(`Malformed keyboard-interactive info request: ${field} exceeds size limit`);
  }

  const valueOffset = offset + 4;
  if (length > payload.length - valueOffset) {
    throw new Error(`Malformed keyboard-interactive info request: truncated ${field}`);
  }

  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      payload.subarray(valueOffset, valueOffset + length)
    );
  } catch {
    throw new Error(`Malformed keyboard-interactive info request: invalid UTF-8 in ${field}`);
  }

  return { value, nextOffset: valueOffset + length };
}

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
  /**
   * Build the RFC 4252 "none" probe used to discover the authentication
   * methods the server actually permits before sending any credential.
   */
  static buildNoneAuthRequest(username: string): Uint8Array {
    return concat(
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('none')
    );
  }

  static buildPasswordAuthRequest(username: string, password: string): Uint8Array {
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

  /** Build RFC 4256 SSH_MSG_USERAUTH_REQUEST for keyboard-interactive auth. */
  static buildKeyboardInteractiveAuthRequest(username: string): Uint8Array {
    return concat(
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('keyboard-interactive'),
      encodeString(''), // language tag (deprecated by RFC 4256)
      encodeString('') // no preferred submethods
    );
  }

  /**
   * Parse an RFC 4256 SSH_MSG_USERAUTH_INFO_REQUEST payload.
   *
   * Every server-controlled field is length-bounded, decoded as strict UTF-8,
   * and the payload must be consumed exactly. This prevents truncated packets,
   * oversized browser prompts, and hidden trailing data from being accepted.
   */
  static parseKeyboardInteractiveInfoRequest(payload: Uint8Array): KeyboardInteractiveInfoRequest {
    if (payload.length === 0 || payload[0] !== SSH_MSG_USERAUTH_INFO_REQUEST) {
      throw new Error('Unexpected keyboard-interactive message type');
    }
    if (payload.length > MAX_KEYBOARD_INTERACTIVE_PACKET_BYTES) {
      throw new Error('Malformed keyboard-interactive info request: packet exceeds size limit');
    }

    let offset = 1;
    const name = decodeSSHStringStrict(
      payload,
      offset,
      'name',
      MAX_KEYBOARD_INTERACTIVE_NAME_BYTES
    );
    offset = name.nextOffset;

    const instruction = decodeSSHStringStrict(
      payload,
      offset,
      'instruction',
      MAX_KEYBOARD_INTERACTIVE_INSTRUCTION_BYTES
    );
    offset = instruction.nextOffset;

    const language = decodeSSHStringStrict(
      payload,
      offset,
      'language',
      MAX_KEYBOARD_INTERACTIVE_LANGUAGE_BYTES
    );
    offset = language.nextOffset;

    if (offset > payload.length - 4) {
      throw new Error('Malformed keyboard-interactive info request: truncated prompt count');
    }
    const promptCount = readUint32(payload, offset);
    offset += 4;
    if (promptCount > MAX_KEYBOARD_INTERACTIVE_PROMPTS) {
      throw new Error('Malformed keyboard-interactive info request: too many prompts');
    }

    const prompts: KeyboardInteractivePrompt[] = [];
    for (let index = 0; index < promptCount; index++) {
      const prompt = decodeSSHStringStrict(
        payload,
        offset,
        `prompt ${index + 1}`,
        MAX_KEYBOARD_INTERACTIVE_PROMPT_BYTES
      );
      offset = prompt.nextOffset;
      if (prompt.value.length === 0) {
        throw new Error(
          `Malformed keyboard-interactive info request: prompt ${index + 1} is empty`
        );
      }

      if (offset >= payload.length) {
        throw new Error(
          `Malformed keyboard-interactive info request: missing echo flag for prompt ${index + 1}`
        );
      }
      const echoByte = payload[offset++];
      if (echoByte !== 0 && echoByte !== 1) {
        throw new Error(
          `Malformed keyboard-interactive info request: invalid echo flag for prompt ${index + 1}`
        );
      }

      prompts.push({ text: prompt.value, echo: echoByte === 1 });
    }

    if (offset !== payload.length) {
      throw new Error('Malformed keyboard-interactive info request: trailing data');
    }

    return {
      name: name.value,
      instruction: instruction.value,
      language: language.value,
      prompts,
    };
  }

  /** Build an RFC 4256 SSH_MSG_USERAUTH_INFO_RESPONSE payload. */
  static buildKeyboardInteractiveInfoResponse(responses: string[]): Uint8Array {
    if (!Array.isArray(responses) || responses.length > MAX_KEYBOARD_INTERACTIVE_PROMPTS) {
      throw new Error('Invalid keyboard-interactive responses: too many responses');
    }

    const encodedResponses: Uint8Array[] = [];
    let totalBytes = 1 + 4;
    for (const response of responses) {
      if (typeof response !== 'string') {
        throw new Error('Invalid keyboard-interactive responses: every response must be a string');
      }
      const encoded = encodeString(response);
      if (encoded.length - 4 > MAX_KEYBOARD_INTERACTIVE_RESPONSE_BYTES) {
        throw new Error('Invalid keyboard-interactive responses: response exceeds size limit');
      }
      totalBytes += encoded.length;
      if (totalBytes > MAX_KEYBOARD_INTERACTIVE_PACKET_BYTES) {
        throw new Error('Invalid keyboard-interactive responses: packet exceeds size limit');
      }
      encodedResponses.push(encoded);
    }

    return concat(
      new Uint8Array([SSH_MSG_USERAUTH_INFO_RESPONSE]),
      encodeUint32(responses.length),
      ...encodedResponses
    );
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
    allowLegacyRsaSha1: boolean = false
  ): Promise<Uint8Array> {
    const { signingKey, publicKeyBlob, keyType, rsaPkcs8 } =
      await SSHAuth.parsePrivateKey(privateKeyPEM);

    // 确定 request / signature 外层算法名（公钥 blob 内部类型不变）
    let requestAlgo = keyType;
    let signatureAlgo = keyType;

    if (keyType === SSH_RSA) {
      const chosen = SSHAuth.selectRsaSigAlgorithm(serverSigAlgs, allowLegacyRsaSha1);
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
      encodeString(publicKeyBlob)
    );

    // Data to sign: session_id_string || request_body
    const dataToSign = concat(encodeString(sessionID), requestBody);

    // Sign based on key type
    let rawSignature: Uint8Array;
    let signatureBlob: Uint8Array;

    if (keyType === SSH_ED25519) {
      rawSignature = new Uint8Array(await crypto.subtle.sign(ED25519_ALGO, signingKey, dataToSign));
      signatureBlob = concat(encodeString(SSH_ED25519), encodeString(rawSignature));
    } else if (keyType === SSH_RSA) {
      const hash =
        signatureAlgo === 'rsa-sha2-512'
          ? 'SHA-512'
          : signatureAlgo === 'ssh-rsa'
            ? 'SHA-1'
            : 'SHA-256';
      // 某些 WebCrypto 实现会在 importKey 时把 RSASSA-PKCS1-v1_5 的 hash 绑定到
      // CryptoKey，导致后续 sign 时即使传不同 hash 也被忽略（用 SHA-256 import
      // 的 key 试签 SHA-512 会得到 SHA-256 签名）。这里在 hash 与 import 时 hash
      // 不一致的情况下重新 import 一次。
      let sigKey = signingKey;
      if (hash !== 'SHA-256' && rsaPkcs8) {
        sigKey = await crypto.subtle.importKey(
          'pkcs8',
          rsaPkcs8,
          { name: 'RSASSA-PKCS1-v1_5', hash },
          false,
          ['sign']
        );
      }
      rawSignature = new Uint8Array(
        await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5', hash }, sigKey, dataToSign)
      );
      signatureBlob = concat(encodeString(signatureAlgo), encodeString(rawSignature));
    } else if (keyType.startsWith('ecdsa-sha2-')) {
      // RFC 5656 §6.2.1: 曲线 → 哈希映射 exhaustive
      const hash = SSHAuth.ecdsaHashForCurve(keyType);
      const sigBytes = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash }, signingKey, dataToSign)
      );
      // 运行时检测 WebCrypto 返回格式（DER 或 raw r||s），不预设
      const sshSignature = SSHAuth.ecdsaWebCryptoToSSH(sigBytes, SSHAuth.ecdsaCoordBytes(keyType));
      signatureBlob = concat(encodeString(keyType), encodeString(sshSignature));
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
    allowLegacyRsaSha1: boolean
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
      case ECDSA_SHA2_NISTP256:
        return 'SHA-256'; // 坐标 32 字节
      case ECDSA_SHA2_NISTP384:
        return 'SHA-384'; // 坐标 48 字节
      case ECDSA_SHA2_NISTP521:
        return 'SHA-512'; // 坐标 66 字节
    }
    // exhaustive: 走到这里说明 keyType 不是三种受支持曲线之一
    throw new Error(`unsupported ECDSA key type: ${keyType}`);
  }

  /**
   * ECDSA 曲线对应的单坐标字节长度（用于 raw r||s 编码）。
   */
  private static ecdsaCoordBytes(keyType: string): number {
    switch (keyType) {
      case ECDSA_SHA2_NISTP256:
        return 32;
      case ECDSA_SHA2_NISTP384:
        return 48;
      case ECDSA_SHA2_NISTP521:
        return 66;
    }
    throw new Error(`unsupported ECDSA key type: ${keyType}`);
  }

  /**
   * 把 WebCrypto ECDSA 签名输出转换为 SSH 的 `string(r) || string(s)` 格式。
   * 运行时检测输入是 DER SEQUENCE 还是 raw `r||s`，不预设 Worker 实现行为。
   */
  private static ecdsaWebCryptoToSSH(sigBytes: Uint8Array, coordBytes: number): Uint8Array {
    if (sigBytes.length < 2) throw new Error('ECDSA 签名长度过短');

    // raw r || s（固定长度 2 * coordBytes）
    // 必须优先按长度识别：raw 的首字节也可能随机为 DER SEQUENCE 标记 0x30。
    if (sigBytes.length === coordBytes * 2) {
      const r = sigBytes.subarray(0, coordBytes);
      const s = sigBytes.subarray(coordBytes);
      // 转成 mpint（去掉前导 0，最高位为 1 时补 0）
      return concat(SSHAuth.sshMPInt(r), SSHAuth.sshMPInt(s));
    }

    // 部分 WebCrypto 实现返回 DER SEQUENCE。
    return SSHAuth.convertECDSADERToSSH(sigBytes);
  }

  /**
   * Parse an OpenSSH private key and detect its type.
   */
  /**
   * 识别 PEM 封装格式并提取 DER 内容。
   *
   * 不能简单剔除 "-----" 开头的行：复制来源带入的杂散文本（如
   * "xxx-----BEGIN ..." 前缀污染）不在剔除范围内，会混进 Base64 解码出
   * 垃圾字节，导致魔数校验误报"格式不支持"。这里按 BEGIN/END 标记对
   * 精确提取正文，并对常见误贴（公钥/证书/PPK/加密 PEM）给出针对性提示。
   */
  private static extractPrivateMaterial(pem: string): {
    format: 'openssh' | 'pkcs1' | 'sec1' | 'pkcs8';
    der: Uint8Array;
  } {
    // 误贴/不支持封装检测：优先于格式分发，给出可执行的下一步指引
    if (RE_CERTIFICATE.test(pem)) {
      throw new Error('检测到 X.509 证书（CERTIFICATE），SSH 认证需要粘贴私钥文件');
    }
    if (RE_PUBLIC_KEY_PEM.test(pem)) {
      throw new Error('检测到公钥（PUBLIC KEY），请粘贴对应的私钥文件（PRIVATE KEY）');
    }
    if (RE_OPENSSH_PUBLIC_LINE.test(pem)) {
      throw new Error('检测到 OpenSSH 公钥（如 ssh-ed25519 AAAA...），请粘贴私钥（无 .pub 后缀的文件）');
    }
    if (RE_PUTTY_PPK.test(pem)) {
      throw new Error('暂不支持 PuTTY PPK 格式，请在 PuTTYgen 中 Conversions → Export OpenSSH key 导出后重试');
    }
    if (RE_TRADITIONAL_ENCRYPTED.test(pem)) {
      throw new Error('不支持口令加密的传统 PEM 私钥，请用 ssh-keygen -p 移除密码后重试');
    }

    // 注意：OPENSSH/RSA/EC 变体必须先于裸 'PRIVATE KEY' 匹配（后者是前缀交集）
    const blocks: Array<{ header: string; format: 'openssh' | 'pkcs1' | 'sec1' | 'pkcs8' }> = [
      { header: 'OPENSSH PRIVATE KEY', format: 'openssh' },
      { header: 'RSA PRIVATE KEY', format: 'pkcs1' },
      { header: 'EC PRIVATE KEY', format: 'sec1' },
      { header: 'PRIVATE KEY', format: 'pkcs8' },
    ];
    for (const { header, format } of blocks) {
      const match = pem.match(
        new RegExp(`-----BEGIN ${header}-----([\\s\\S]*?)-----END ${header}-----`),
      );
      if (match) {
        return { format, der: decodePemBase64(match[1]) };
      }
    }
    const other = pem.match(RE_ANY_BEGIN);
    if (other) {
      throw new Error(
        `不支持的密钥封装格式: ${other[1].trim()}（加密私钥暂不支持，请用 ssh-keygen -p 移除口令后重试）`,
      );
    }
    // 无 PEM 标记：按裸 Base64 正文处理（兼容直接粘贴密钥内容），按魔数区分封装
    const raw = decodePemBase64(pem);
    const magic = 'openssh-key-v1\0';
    const magicBytes = new TextEncoder().encode(magic);
    let isOpenssh = raw.length >= magicBytes.length;
    for (let i = 0; isOpenssh && i < magicBytes.length; i++) {
      if (raw[i] !== magicBytes[i]) isOpenssh = false;
    }
    return isOpenssh ? { format: 'openssh', der: raw } : { format: 'pkcs8', der: raw };
  }

  /**
   * 解析私钥：按封装格式分发到 OpenSSH / PKCS#1 / SEC1 / PKCS#8 解析器，
   * 各路径殊途同归产出统一的 ParsedKey（signingKey + SSH 公钥 blob）。
   */
  private static async parsePrivateKey(pem: string): Promise<ParsedKey> {
    const { format, der } = SSHAuth.extractPrivateMaterial(pem);
    switch (format) {
      case 'openssh':
        return SSHAuth.parseOpenSSHPrivateKey(der);
      case 'pkcs1':
        return SSHAuth.parsedKeyFromPkcs1(der);
      case 'sec1':
        return SSHAuth.parsedKeyFromSec1(der);
      case 'pkcs8':
        return SSHAuth.parsedKeyFromPkcs8(der);
      default:
        throw new Error(`不支持的私钥封装格式: ${format}`);
    }
  }

  /** 解析 OpenSSH 新格式（openssh-key-v1）私钥。 */
  private static async parseOpenSSHPrivateKey(raw: Uint8Array): Promise<ParsedKey> {
    // Parse OpenSSH format: "openssh-key-v1\0" magic
    const magic = 'openssh-key-v1\0';
    const magicBytes = new TextEncoder().encode(magic);
    if (raw.length < magicBytes.length) {
      throw new Error('私钥数据太短');
    }
    for (let i = 0; i < magicBytes.length; i++) {
      if (raw[i] !== magicBytes[i]) {
        throw new Error('私钥数据损坏：OpenSSH 魔数不匹配，请重新完整复制密钥');
      }
    }
    let offset = magicBytes.length;

    // ciphername
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：cipherLen 越界');
    const cipherLen = readUint32(raw, offset);
    offset += 4;
    if (offset + cipherLen > raw.length) throw new Error('私钥格式损坏：cipher 越界');
    const cipher = new TextDecoder().decode(raw.slice(offset, offset + cipherLen));
    offset += cipherLen;
    if (cipher !== 'none') throw new Error('不支持加密的私钥，请使用 ssh-keygen -p 移除密码');

    // kdfname
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：kdfLen 越界');
    const kdfLen = readUint32(raw, offset);
    offset += 4;
    if (offset + kdfLen > raw.length) throw new Error('私钥格式损坏：kdf 越界');
    offset += kdfLen;

    // kdfoptions
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：kdfOptLen 越界');
    const kdfOptLen = readUint32(raw, offset);
    offset += 4;
    if (offset + kdfOptLen > raw.length) throw new Error('私钥格式损坏：kdfoptions 越界');
    offset += kdfOptLen;

    // number of keys
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：numKeys 越界');
    const numKeys = readUint32(raw, offset);
    offset += 4;
    if (numKeys !== 1) throw new Error('仅支持单密钥文件');

    // public key section
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：pubSecLen 越界');
    const pubSecLen = readUint32(raw, offset);
    offset += 4;
    if (offset + pubSecLen > raw.length) throw new Error('私钥格式损坏：pubSection 越界');
    offset += pubSecLen;

    // private key section
    if (offset + 4 > raw.length) throw new Error('私钥格式损坏：privSecLen 越界');
    const privSecLen = readUint32(raw, offset);
    offset += 4;
    if (offset + privSecLen > raw.length) throw new Error('私钥格式损坏：privSection 越界');
    const privSection = raw.slice(offset, offset + privSecLen);

    // Parse private section: checkint1, checkint2, keytype, ...
    let po = 0;
    if (privSection.length < 8) throw new Error('私钥格式损坏：checkints 越界');
    po += 4; // checkint1
    po += 4; // checkint2

    // key type
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：keyTypeLen 越界');
    const ktLen = readUint32(privSection, po);
    po += 4;
    if (po + ktLen > privSection.length) throw new Error('私钥格式损坏：keyType 越界');
    const keyType = new TextDecoder().decode(privSection.slice(po, po + ktLen));
    po += ktLen;

    // Parse based on key type
    if (keyType === SSH_ED25519) {
      return SSHAuth.parseEd25519Key(privSection, po);
    } else if (keyType === SSH_RSA) {
      return SSHAuth.parseRSAKey(privSection, po);
    } else if (keyType.startsWith('ecdsa-sha2-')) {
      return SSHAuth.parseECDSAKey(privSection, po, keyType);
    } else {
      throw new Error(`不支持的密钥类型: ${keyType}`);
    }
  }

  /**
   * Parse Ed25519 private key from OpenSSH format.
   */
  private static async parseEd25519Key(
    privSection: Uint8Array,
    offset: number
  ): Promise<ParsedKey> {
    let po = offset;

    // public key (32 bytes)
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：pubKeyLen 越界');
    const pubKeyLen = readUint32(privSection, po);
    po += 4;
    if (po + pubKeyLen > privSection.length) throw new Error('私钥格式损坏：pubKey 越界');
    const pubKeyRaw = privSection.slice(po, po + pubKeyLen);
    po += pubKeyLen;

    // private key (64 bytes = 32 bytes seed + 32 bytes pubkey)
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：privKeyLen 越界');
    const privKeyLen = readUint32(privSection, po);
    po += 4;
    if (po + privKeyLen > privSection.length) throw new Error('私钥格式损坏：privKey 越界');
    const privKeyRaw = privSection.slice(po, po + privKeyLen);
    if (privKeyRaw.length < 32) throw new Error('私钥格式损坏：种子长度不足 32 字节');

    const seed = privKeyRaw.slice(0, 32);

    const pkcs8 = SSHAuth.buildEd25519PKCS8(seed);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: ED25519_ALGO },
      false,
      ['sign']
    );

    const publicKeyBlob = concat(encodeString(SSH_ED25519), encodeString(pubKeyRaw));

    return { signingKey, publicKeyBlob, keyType: SSH_ED25519 };
  }

  /**
   * Parse RSA private key from OpenSSH format.
   */
  private static async parseRSAKey(privSection: Uint8Array, offset: number): Promise<ParsedKey> {
    let po = offset;

    const readMPINT = (): Uint8Array => {
      if (po + 4 > privSection.length) throw new Error('私钥格式损坏：MPINT 越界');
      const len = readUint32(privSection, po);
      po += 4;
      if (po + len > privSection.length) throw new Error('私钥格式损坏：MPINT 数据越界');
      const data = privSection.slice(po, po + len);
      po += len;
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

    const pkcs8 = SSHAuth.buildRSAPKCS8(n, e, d, p, q, iqmp);

    // 注意：RSASSA-PKCS1-v1_5 在 importKey 时把 hash 绑定到 CryptoKey 上，
    // 后续 sign 时即使传不同 hash 也会被某些 WebCrypto 实现忽略。
    // 因此这里用一个固定 hash(任意)先导入，供 build 在使用 SHA-256 路径时复用；
    // 用 SHA-512 时会基于 rsaPkcs8 字段重新 import。
    const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_ALGO, false, ['sign']);

    const publicKeyBlob = concat(encodeString(SSH_RSA), SSHAuth.sshMPInt(e), SSHAuth.sshMPInt(n));

    return { signingKey, rsaPkcs8: pkcs8, publicKeyBlob, keyType: SSH_RSA };
  }

  /**
   * Parse ECDSA private key from OpenSSH format.
   */
  private static async parseECDSAKey(
    privSection: Uint8Array,
    offset: number,
    keyType: string
  ): Promise<ParsedKey> {
    let po = offset;

    let namedCurve: EcNamedCurve;

    if (keyType === ECDSA_SHA2_NISTP256) {
      namedCurve = 'P-256';
    } else if (keyType === ECDSA_SHA2_NISTP384) {
      namedCurve = 'P-384';
    } else if (keyType === ECDSA_SHA2_NISTP521) {
      namedCurve = 'P-521';
    } else {
      throw new Error(`不支持的 ECDSA 曲线: ${keyType}`);
    }

    // curve name
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：curveLen 越界');
    const curveLen = readUint32(privSection, po);
    po += 4;
    if (po + curveLen > privSection.length) throw new Error('私钥格式损坏：curve 越界');
    const curve = new TextDecoder().decode(privSection.slice(po, po + curveLen));
    po += curveLen;

    const expectedCurve = namedCurve.replace('P-', 'nistp');
    if (curve !== expectedCurve) {
      throw new Error(`曲线不匹配: 期望 ${expectedCurve}，实际 ${curve}`);
    }

    // public key
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：pubKeyLen 越界');
    const pubKeyLen = readUint32(privSection, po);
    po += 4;
    if (po + pubKeyLen > privSection.length) throw new Error('私钥格式损坏：pubKey 越界');
    const pubKeyRaw = privSection.slice(po, po + pubKeyLen);
    po += pubKeyLen;

    // private key
    if (po + 4 > privSection.length) throw new Error('私钥格式损坏：privKeyLen 越界');
    const privKeyLen = readUint32(privSection, po);
    po += 4;
    if (po + privKeyLen > privSection.length) throw new Error('私钥格式损坏：privKey 越界');
    const privKeyRaw = privSection.slice(po, po + privKeyLen);

    // OpenSSH 格式自带公钥点，直接透传给共享构建器
    return SSHAuth.parsedKeyFromEcComponents(namedCurve, privKeyRaw, pubKeyRaw);
  }

  /**
   * 由 RSA CRT 组件构建 ParsedKey（PKCS#1 / PKCS#8 路径共用；OpenSSH 路径保留内联实现）。
   */
  private static async parsedKeyFromRsaComponents(key: RsaComponents): Promise<ParsedKey> {
    const { n, e, d, p, q, iqmp } = key;

    const pkcs8 = SSHAuth.buildRSAPKCS8(n, e, d, p, q, iqmp);

    // 注意：RSASSA-PKCS1-v1_5 在 importKey 时把 hash 绑定到 CryptoKey 上，
    // 后续 sign 时即使传不同 hash 也被某些 WebCrypto 实现忽略。
    // 因此这里用一个固定 hash(任意)先导入，供 build 在使用 SHA-256 路径时复用；
    // 用 SHA-512 时会基于 rsaPkcs8 字段重新 import。
    const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_ALGO, false, ['sign']);

    const publicKeyBlob = concat(encodeString(SSH_RSA), SSHAuth.sshMPInt(e), SSHAuth.sshMPInt(n));

    return { signingKey, rsaPkcs8: pkcs8, publicKeyBlob, keyType: SSH_RSA };
  }

  /**
   * 由 EC 组件构建 ParsedKey（OpenSSH / SEC1 / PKCS#8 路径共用）。
   *
   * @param publicKeyHint 非压缩公钥点（0x04 || X || Y）；OpenSSH/SEC1 文件通常自带。
   *   缺失时（PKCS#8 等仅含私钥的封装）经 JWK 导出从私钥推导，此时 CryptoKey 为可导出。
   */
  private static async parsedKeyFromEcComponents(
    namedCurve: EcNamedCurve,
    privateKeyBytes: Uint8Array,
    publicKeyHint: Uint8Array | null
  ): Promise<ParsedKey> {
    const keyType =
      namedCurve === 'P-256'
        ? ECDSA_SHA2_NISTP256
        : namedCurve === 'P-384'
          ? ECDSA_SHA2_NISTP384
          : ECDSA_SHA2_NISTP521;
    const algo =
      namedCurve === 'P-256'
        ? ECDSA_P256_ALGO
        : namedCurve === 'P-384'
          ? ECDSA_P384_ALGO
          : ECDSA_P521_ALGO;
    const sshCurve = namedCurve.replace('P-', 'nistp');
    const pkcs8 = SSHAuth.buildECDSAPKCS8(namedCurve, privateKeyBytes);

    if (!publicKeyHint) {
      // 部分工具导出的私钥不含公钥点：导入后经 JWK 导出推导
      const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8, algo, true, ['sign']);
      // 运行时 'jwk' 格式必然返回 JsonWebKey（DOM 类型为 ArrayBuffer | JsonWebKey 联合）
      const jwk = (await crypto.subtle.exportKey('jwk', signingKey)) as JsonWebKey;
      if (!jwk.x || !jwk.y) {
        throw new Error('无法从 EC 私钥推导公钥，请使用包含公钥参数的密钥文件');
      }
      const q = concat(new Uint8Array([0x04]), base64UrlDecode(jwk.x), base64UrlDecode(jwk.y));
      const publicKeyBlob = concat(
        encodeString(keyType),
        encodeString(sshCurve),
        encodeString(q)
      );
      return { signingKey, publicKeyBlob, keyType };
    }

    const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8, algo, false, ['sign']);

    const publicKeyBlob = concat(
      encodeString(keyType),
      encodeString(sshCurve),
      encodeString(publicKeyHint)
    );

    return { signingKey, publicKeyBlob, keyType };
  }

  /**
   * 由 Ed25519 种子构建 ParsedKey（PKCS#8 路径专用）。
   * PKCS#8 不携带公钥：导入后经 JWK 导出推导（OpenSSH 路径自带公钥，不走此处）。
   */
  private static async parsedKeyFromEd25519Seed(seed: Uint8Array): Promise<ParsedKey> {
    const pkcs8 = SSHAuth.buildEd25519PKCS8(seed);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: ED25519_ALGO },
      true,
      ['sign']
    );
    const jwk = (await crypto.subtle.exportKey('jwk', signingKey)) as JsonWebKey;
    if (!jwk.x) {
      throw new Error('无法从 Ed25519 私钥推导公钥');
    }
    const publicKeyBlob = concat(
      encodeString(SSH_ED25519),
      encodeString(base64UrlDecode(jwk.x))
    );
    return { signingKey, publicKeyBlob, keyType: SSH_ED25519 };
  }

  /** PKCS#1（BEGIN RSA PRIVATE KEY）→ ParsedKey。 */
  private static async parsedKeyFromPkcs1(der: Uint8Array): Promise<ParsedKey> {
    return SSHAuth.parsedKeyFromRsaComponents(parsePkcs1Rsa(der));
  }

  /** SEC1（BEGIN EC PRIVATE KEY）→ ParsedKey。 */
  private static async parsedKeyFromSec1(der: Uint8Array): Promise<ParsedKey> {
    const key = parseSec1Ec(der);
    return SSHAuth.parsedKeyFromEcComponents(key.namedCurve, key.privateKey, key.publicKey);
  }

  /** PKCS#8（BEGIN PRIVATE KEY）→ ParsedKey，按算法 OID 分发。 */
  private static async parsedKeyFromPkcs8(der: Uint8Array): Promise<ParsedKey> {
    const key = parsePkcs8(der);
    switch (key.kind) {
      case 'rsa':
        return SSHAuth.parsedKeyFromRsaComponents(key);
      case 'ec':
        return SSHAuth.parsedKeyFromEcComponents(key.namedCurve, key.privateKey, key.publicKey);
      case 'ed25519':
        return SSHAuth.parsedKeyFromEd25519Seed(key.seed);
      default:
        throw new Error(`不支持的密钥类型: ${(key as { kind: string }).kind}`);
    }
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
    n: Uint8Array,
    e: Uint8Array,
    d: Uint8Array,
    p: Uint8Array,
    q: Uint8Array,
    iqmp: Uint8Array
  ): Uint8Array {
    const pkcs1 = SSHAuth.buildRSAPKCS1(n, e, d, p, q, iqmp);

    const rsaOid = new Uint8Array([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    ]);
    const nullParam = new Uint8Array([0x05, 0x00]);
    const algoSeq = SSHAuth.buildDERSequence(concat(rsaOid, nullParam));

    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const privKeyOctet = SSHAuth.buildDEROctetString(pkcs1);

    return SSHAuth.buildDERSequence(concat(version, algoSeq, privKeyOctet));
  }

  /**
   * Build PKCS#1 RSAPrivateKey DER format.
   */
  private static buildRSAPKCS1(
    n: Uint8Array,
    e: Uint8Array,
    d: Uint8Array,
    p: Uint8Array,
    q: Uint8Array,
    iqmp: Uint8Array
  ): Uint8Array {
    const version = SSHAuth.buildDERInteger(new Uint8Array([0]));
    const modulus = SSHAuth.buildDERInteger(n);
    const publicExp = SSHAuth.buildDERInteger(e);
    const privateExp = SSHAuth.buildDERInteger(d);
    const prime1 = SSHAuth.buildDERInteger(p);
    const prime2 = SSHAuth.buildDERInteger(q);

    const pMinus1 = SSHAuth.bigIntSubtract(p, new Uint8Array([1]));
    const qMinus1 = SSHAuth.bigIntSubtract(q, new Uint8Array([1]));
    const exponent1 = SSHAuth.buildDERInteger(SSHAuth.bigIntMod(d, pMinus1));
    const exponent2 = SSHAuth.buildDERInteger(SSHAuth.bigIntMod(d, qMinus1));
    const coefficient = SSHAuth.buildDERInteger(iqmp);

    return SSHAuth.buildDERSequence(
      concat(
        version,
        modulus,
        publicExp,
        privateExp,
        prime1,
        prime2,
        exponent1,
        exponent2,
        coefficient
      )
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

    const ecVersion = SSHAuth.buildDERInteger(new Uint8Array([1]));
    const ecPrivKeyOctet = SSHAuth.buildDEROctetString(privateKey);
    const parameters = new Uint8Array([0xa0, curveOid.length, ...curveOid]);
    const ecPrivateKey = SSHAuth.buildDERSequence(concat(ecVersion, ecPrivKeyOctet, parameters));

    const ecOid = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
    const algoSeq = SSHAuth.buildDERSequence(concat(ecOid, curveOid));

    const pkcs8Version = SSHAuth.buildDERInteger(new Uint8Array([0]));
    const privateKeyOctet = SSHAuth.buildDEROctetString(ecPrivateKey);

    return SSHAuth.buildDERSequence(concat(pkcs8Version, algoSeq, privateKeyOctet));
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

    return concat(new Uint8Array([0x02]), SSHAuth.encodeDERLength(data.length), data);
  }

  /**
   * Build DER OCTET STRING.
   */
  private static buildDEROctetString(data: Uint8Array): Uint8Array {
    return concat(new Uint8Array([0x04]), SSHAuth.encodeDERLength(data.length), data);
  }

  /**
   * Build DER SEQUENCE.
   */
  private static buildDERSequence(data: Uint8Array): Uint8Array {
    return concat(new Uint8Array([0x30]), SSHAuth.encodeDERLength(data.length), data);
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

    const readLength = (): number => {
      if (offset >= derSignature.length) throw new Error('无效的 DER 签名格式');

      const first = derSignature[offset++];
      if (first < 0x80) return first;

      const lenBytes = first & 0x7f;
      if (lenBytes === 0 || lenBytes > 2 || offset + lenBytes > derSignature.length) {
        throw new Error('无效的 DER 签名格式');
      }

      let length = 0;
      for (let i = 0; i < lenBytes; i++) {
        length = (length << 8) | derSignature[offset++];
      }
      if (length < 0x80) throw new Error('无效的 DER 签名格式');
      return length;
    };

    const sequenceLength = readLength();
    const sequenceEnd = offset + sequenceLength;
    if (sequenceEnd !== derSignature.length) throw new Error('无效的 DER 签名格式');

    const readInteger = (): Uint8Array => {
      if (offset >= sequenceEnd || derSignature[offset++] !== 0x02) {
        throw new Error('无效的 DER 签名格式');
      }

      const length = readLength();
      if (length === 0 || offset + length > sequenceEnd) {
        throw new Error('无效的 DER 签名格式');
      }

      const value = derSignature.slice(offset, offset + length);
      offset += length;
      return value;
    };

    let r = readInteger();
    let s = readInteger();
    if (offset !== sequenceEnd) throw new Error('无效的 DER 签名格式');

    while (r.length > 1 && r[0] === 0) r = r.slice(1);
    while (s.length > 1 && s[0] === 0) s = s.slice(1);

    return concat(encodeString(r), encodeString(s));
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
    const data = needsLeadingZero ? concat(new Uint8Array([0]), significant) : significant;

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
    if (payload.length === 0) {
      throw new Error('Unexpected empty auth response');
    }
    const msgType = payload[0];

    switch (msgType) {
      case SSH_MSG_USERAUTH_SUCCESS:
        return { success: true };

      case SSH_MSG_USERAUTH_FAILURE: {
        if (payload.length < 5) {
          throw new Error('Malformed USERAUTH_FAILURE: truncated method list length');
        }
        const len = readUint32(payload, 1);
        if (len > payload.length - 5) {
          throw new Error('Malformed USERAUTH_FAILURE: truncated method list');
        }

        const partialSuccessOffset = 5 + len;
        if (payload.length < partialSuccessOffset + 1) {
          throw new Error('Malformed USERAUTH_FAILURE: missing partial success flag');
        }
        if (payload.length > partialSuccessOffset + 1) {
          throw new Error('Malformed USERAUTH_FAILURE: trailing data');
        }

        let methods: string;
        try {
          methods = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
            payload.subarray(5, 5 + len)
          );
        } catch {
          throw new Error('Malformed USERAUTH_FAILURE: invalid method list encoding');
        }

        const partialSuccessByte = payload[partialSuccessOffset];
        if (partialSuccessByte !== 0 && partialSuccessByte !== 1) {
          throw new Error('Malformed USERAUTH_FAILURE: invalid partial success flag');
        }
        const partialSuccess = partialSuccessByte === 1;

        return {
          success: false,
          allowedMethods: methods === '' ? [] : methods.split(','),
          partialSuccess,
        };
      }

      default:
        throw new Error(`Unexpected auth message type: ${msgType}`);
    }
  }
}
