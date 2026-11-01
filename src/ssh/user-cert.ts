import { HOST_CERTIFICATE_ALGORITHMS } from './algorithms';
import { concat, encodeString } from './utils';

const MAX_CERT_BYTES = 64 * 1024;
const MAX_CERT_FIELD_BYTES = 16 * 1024;
const MAX_CERT_ENTRIES = 256;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const SSH_CERT_TYPE_USER = 1;
export const SSH_CERT_TYPE_HOST = 2;

class CertReader {
  offset = 0;

  constructor(readonly data: Uint8Array, limit = MAX_CERT_BYTES) {
    if (data.length > limit) throw new Error('SSH 证书超出大小限制');
  }

  private require(length: number): void {
    if (length > this.data.length - this.offset) throw new Error('SSH 证书数据截断');
  }

  uint32(): number {
    this.require(4);
    const value = new DataView(
      this.data.buffer,
      this.data.byteOffset + this.offset,
      4
    ).getUint32(0);
    this.offset += 4;
    return value;
  }

  uint64(): bigint {
    return (BigInt(this.uint32()) << 32n) | BigInt(this.uint32());
  }

  string(limit = MAX_CERT_FIELD_BYTES): Uint8Array {
    const length = this.uint32();
    if (length > limit) throw new Error('SSH 证书字段超出大小限制');
    this.require(length);
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  name(): string {
    const value = decoder.decode(this.string(128));
    if (!/^[\x21-\x7e]+$/.test(value)) throw new Error('无效的 SSH 算法名称');
    return value;
  }

  positiveMPInt(limit: number): Uint8Array {
    const value = this.string(limit);
    if (
      !value.length ||
      value[0] & 0x80 ||
      (value.length === 1 && value[0] === 0) ||
      (value.length > 1 && value[0] === 0 && !(value[1] & 0x80))
    ) {
      throw new Error('无效的正 SSH mpint');
    }
    return value;
  }

  end(): void {
    if (this.offset !== this.data.length) throw new Error('SSH 证书末尾存在多余数据');
  }
}

export interface UserCertificateInfo {
  /** 证书外层算法名，例如 ssh-ed25519-cert-v01@openssh.com */
  certType: string;
  /** 底层裸公钥算法名，例如 ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa */
  underlyingKeyType: string;
  /** 从证书主体中重构出的标准裸公钥 wire blob，用于与私钥进行恒等比对 */
  publicKeyBlob: Uint8Array;
  /** 完整的证书二进制 wire blob，用于 USERAUTH_REQUEST 的 public key blob 字段 */
  rawBlob: Uint8Array;
  serial: bigint;
  type: number;
  keyId: string;
  principals: string[];
  validAfter: bigint;
  validBefore: bigint;
  caPublicKeyBlob: Uint8Array;
}

const EC_KEY_LENGTHS = {
  'ecdsa-sha2-nistp256': { curve: 'nistp256', bytes: 32 },
  'ecdsa-sha2-nistp384': { curve: 'nistp384', bytes: 48 },
  'ecdsa-sha2-nistp521': { curve: 'nistp521', bytes: 66 },
} as const;

type ECKeyType = keyof typeof EC_KEY_LENGTHS;

/**
 * 将单行 OpenSSH 证书文本（如 `ssh-ed25519-cert-v01@openssh.com AAAA... [comment]`）
 * 或裸 Base64 / 二进制 Uint8Array 解码为 Uint8Array wire blob。
 */
export function decodeCertificateBlob(certInput: string | Uint8Array): Uint8Array {
  if (certInput instanceof Uint8Array) {
    return certInput;
  }

  const trimmed = certInput.trim();
  if (!trimmed) {
    throw new Error('证书内容为空');
  }

  // 检查是否为标准单行格式：<algorithm> <base64> [comment]
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && parts[0].includes('-cert-v01@openssh.com')) {
    try {
      const binary = atob(parts[1]);
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
      throw new Error('OpenSSH 证书 Base64 内容损坏，请重新复制证书');
    }
  }

  // 尝试按裸 Base64 解码
  const cleanBase64 = trimmed.replace(/\s+/g, '');
  try {
    const binary = atob(cleanBase64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    throw new Error('无效的 OpenSSH 证书格式，预期为单行以 -cert-v01@openssh.com 开头的证书');
  }
}

/**
 * 解析 OpenSSH 用户证书（PROTOCOL.certkeys）。
 * 严格校验证书类型为 SSH_CERT_TYPE_USER (1)，并提取证书主体公钥以便与私钥比对。
 */
export function parseOpenSshUserCertificate(
  certInput: string | Uint8Array,
  now = Date.now()
): UserCertificateInfo {
  const blob = decodeCertificateBlob(certInput);
  if (blob.length > MAX_CERT_BYTES) {
    throw new Error('SSH 证书超出大小限制（最大 64KB）');
  }

  const reader = new CertReader(blob);
  const certType = reader.name();
  const certSpec = Object.values(HOST_CERTIFICATE_ALGORITHMS).find(
    (entry) => entry.keyType === certType
  );
  if (!certSpec) {
    throw new Error(`不支持的 SSH 证书类型: ${certType}`);
  }

  reader.string(1024); // nonce

  // 提取证书主体公钥字段以重构 publicKeyBlob
  const subjectStart = reader.offset;
  const rawType = certSpec.signatureType.startsWith('rsa-') ? 'ssh-rsa' : certSpec.signatureType;

  if (rawType === 'ssh-ed25519') {
    if (reader.string(32).length !== 32) throw new Error('Ed25519 证书公钥长度无效');
  } else if (rawType === 'ssh-rsa') {
    reader.positiveMPInt(9); // exponent
    reader.positiveMPInt(1025); // modulus
  } else if (Object.hasOwn(EC_KEY_LENGTHS, rawType)) {
    const { curve, bytes } = EC_KEY_LENGTHS[rawType as ECKeyType];
    if (reader.name() !== curve) throw new Error('ECDSA 证书曲线与类型不匹配');
    const point = reader.string(1 + 2 * bytes);
    if (point.length !== 1 + 2 * bytes || point[0] !== 4) {
      throw new Error('ECDSA 证书公钥点无效');
    }
  } else {
    throw new Error(`不支持的证书密钥类型: ${rawType}`);
  }

  const publicKeyBlob = concat(encodeString(rawType), blob.subarray(subjectStart, reader.offset));

  const serial = reader.uint64();
  const type = reader.uint32();
  if (type !== SSH_CERT_TYPE_USER) {
    throw new Error(
      type === SSH_CERT_TYPE_HOST
        ? '检测到 SSH 主机证书，用户登录需要使用用户证书（User Certificate）'
        : `未知的 SSH 证书类型标识: ${type}`
    );
  }

  // keyId (用于审计标识)
  const keyIdBytes = reader.string(4096);
  const keyId = decoder.decode(keyIdBytes);

  // principals 列表
  const principalsData = reader.string(MAX_CERT_FIELD_BYTES);
  const principalsReader = new CertReader(principalsData);
  const principals: string[] = [];
  let principalCount = 0;
  while (principalsReader.offset < principalsData.length) {
    if (++principalCount > MAX_CERT_ENTRIES) {
      throw new Error('证书包含过多的 Principal 条目');
    }
    const pStr = decoder.decode(principalsReader.string(1024));
    principals.push(pStr);
  }

  const validAfter = reader.uint64();
  const validBefore = reader.uint64();

  // 时间有效性检查
  const currentSec = BigInt(Math.floor(now / 1000));
  if (validBefore <= validAfter) {
    throw new Error('SSH 证书有效时间范围无效（validBefore <= validAfter）');
  }
  if (currentSec < validAfter) {
    throw new Error(`SSH 证书尚未生效（生效时间: ${new Date(Number(validAfter) * 1000).toISOString()}）`);
  }
  if (currentSec >= validBefore) {
    throw new Error(`SSH 证书已过期（过期时间: ${new Date(Number(validBefore) * 1000).toISOString()}）`);
  }

  reader.string(); // critical options
  reader.string(); // extensions
  reader.string(); // reserved
  const caPublicKeyBlob = reader.string();
  reader.string(MAX_CERT_FIELD_BYTES); // ca signature
  reader.end();

  return {
    certType,
    underlyingKeyType: rawType,
    publicKeyBlob,
    rawBlob: blob,
    serial,
    type,
    keyId,
    principals,
    validAfter,
    validBefore,
    caPublicKeyBlob,
  };
}

/**
 * 从可能包含混合内容的文本（如用户同时粘贴私钥与证书）中，提取私钥 PEM 与单行证书。
 */
export function extractPrivateKeyAndCertificate(input: string): {
  privateKey: string;
  certificate?: string;
} {
  const lines = input.split(/\r?\n/);
  const remainingLines: string[] = [];
  let certificate: string | undefined;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('ssh-') && trimmedLine.includes('-cert-v01@openssh.com')) {
      if (!certificate) {
        certificate = trimmedLine;
        continue;
      }
    }
    if (trimmedLine.startsWith('ecdsa-sha2-') && trimmedLine.includes('-cert-v01@openssh.com')) {
      if (!certificate) {
        certificate = trimmedLine;
        continue;
      }
    }
    if (trimmedLine.startsWith('rsa-sha2-') && trimmedLine.includes('-cert-v01@openssh.com')) {
      if (!certificate) {
        certificate = trimmedLine;
        continue;
      }
    }
    remainingLines.push(line);
  }

  return {
    privateKey: remainingLines.join('\n').trim(),
    certificate,
  };
}
