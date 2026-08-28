/**
 * 多格式私钥导入回归测试（P0-A：PKCS#1 / PKCS#8 / SEC1）。
 *
 * 夹具与既有 OpenSSH 夹具是同一把密钥的不同编码（转换后经 ssh-keygen -y
 * 校验公钥一致；Ed25519 PKCS#8 因 LibreSSL 无法读取，由 Node webcrypto
 * 在本文件内验证）。核心不变量：同一密钥无论封装格式，产出的 SSH 公钥
 * blob 必须完全一致，且签名可通过 blob 内公钥完成验证。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SSHAuth } from '../../src/ssh/auth';
import { DerError } from '../../src/ssh/der';
import { parseSec1Ec } from '../../src/ssh/pkcs';
import { concat, encodeString, readUint32 } from '../../src/ssh/utils';

const FIXTURES_DIR = join(__dirname, 'fixtures');

function loadKey(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8').trim();
}

// 同一密钥的三种 / 两种编码
const RSA_OPENSSH = loadKey('id_rsa_2048');
const RSA_PKCS1 = loadKey('id_rsa_2048_pkcs1.pem');
const RSA_PKCS8 = loadKey('id_rsa_2048_pkcs8.pem');
const EC_OPENSSH = loadKey('id_ecdsa_256');
const EC_SEC1 = loadKey('id_ecdsa_256_sec1.pem');
const EC_PKCS8 = loadKey('id_ecdsa_256_pkcs8.pem');
const ED25519_OPENSSH = loadKey('id_ed25519');
const ED25519_PKCS8 = loadKey('id_ed25519_pkcs8.pem');

// 固定 sessionID（测试可复现，与 auth-pubkey.test.ts 相同方式生成）
const SESSION_ID = new Uint8Array(32);
for (let i = 0; i < 32; i++) SESSION_ID[i] = i + 1;

interface ParsedRequest {
  requestAlgo: string;
  publicKeyBlob: Uint8Array;
  signatureAlgo: string;
  signatureValue: Uint8Array;
  dataToSign: Uint8Array;
}

/** 解析 USERAUTH_REQUEST 包（结构见 auth-pubkey.test.ts 顶部注释）。 */
function parseRequest(packet: Uint8Array): ParsedRequest {
  let offset = 1; // SSH_MSG_USERAUTH_REQUEST
  const skipString = () => {
    const len = readUint32(packet, offset);
    offset += 4 + len;
  };
  skipString(); // username
  skipString(); // service
  skipString(); // method
  offset += 1; // hasSig = TRUE
  const readString = () => {
    const len = readUint32(packet, offset);
    const data = packet.subarray(offset + 4, offset + 4 + len);
    offset += 4 + len;
    return data;
  };
  const requestAlgo = new TextDecoder().decode(readString());
  const publicKeyBlob = readString();

  // requestBody 止于公钥 blob 末尾：dataToSign = string(session_id) || requestBody
  const requestBody = packet.subarray(0, offset);

  // 外层 string(signature_blob)：内部才是 string(sig_algo) + string(raw_sig)
  const sigBlobLen = readUint32(packet, offset);
  offset += 4;
  const sigBlob = packet.subarray(offset, offset + sigBlobLen);
  let so = 0;
  const sigAlgoLen = readUint32(sigBlob, so);
  so += 4;
  const signatureAlgo = new TextDecoder().decode(sigBlob.subarray(so, so + sigAlgoLen));
  so += sigAlgoLen;
  const rawSigLen = readUint32(sigBlob, so);
  so += 4;
  const signatureValue = sigBlob.subarray(so, so + rawSigLen);

  const dataToSign = concat(encodeString(SESSION_ID), requestBody);
  return {
    requestAlgo,
    publicKeyBlob,
    signatureAlgo,
    signatureValue,
    dataToSign,
  };
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

describe('多格式私钥导入 — RSA（PKCS#1 / PKCS#8）', () => {
  it('同一密钥三种编码产出完全一致的公钥 blob', async () => {
    const fromOpenSSH = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', RSA_OPENSSH, SESSION_ID)
    );
    const fromPkcs1 = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', RSA_PKCS1, SESSION_ID)
    );
    const fromPkcs8 = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', RSA_PKCS8, SESSION_ID)
    );

    expect(Buffer.from(fromPkcs1.publicKeyBlob).equals(fromOpenSSH.publicKeyBlob)).toBe(true);
    expect(Buffer.from(fromPkcs8.publicKeyBlob).equals(fromOpenSSH.publicKeyBlob)).toBe(true);
    // 三种编码的签名算法协商结果一致，且为 RSA-SHA2 家族（非遗留 ssh-rsa）
    expect(fromPkcs1.requestAlgo).toBe(fromOpenSSH.requestAlgo);
    expect(fromPkcs8.requestAlgo).toBe(fromOpenSSH.requestAlgo);
    expect(fromOpenSSH.requestAlgo).toMatch(/^rsa-sha2-(256|512)$/);
  });

  it('PKCS#1 签名可通过 blob 内公钥（JWK）验证', async () => {
    const parsed = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', RSA_PKCS1, SESSION_ID)
    );

    // blob: string("ssh-rsa") + mpint(e) + mpint(n)
    let off = 0;
    const readStr = () => {
      const len = readUint32(parsed.publicKeyBlob, off);
      const data = parsed.publicKeyBlob.subarray(off + 4, off + 4 + len);
      off += 4 + len;
      return data;
    };
    expect(new TextDecoder().decode(readStr())).toBe('ssh-rsa');
    const e = readStr();
    const n = readStr();

    const pubKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: b64url(n), e: b64url(e) },
      { name: 'RSASSA-PKCS1-v1_5', hash: parsed.requestAlgo === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5', hash: parsed.requestAlgo === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256' },
      pubKey,
      parsed.signatureValue,
      parsed.dataToSign
    );
    expect(ok).toBe(true);
  });
});

describe('多格式私钥导入 — ECDSA（SEC1 / PKCS#8）', () => {
  it('同一密钥三种编码产出完全一致的公钥 blob', async () => {
    const fromOpenSSH = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', EC_OPENSSH, SESSION_ID)
    );
    const fromSec1 = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', EC_SEC1, SESSION_ID)
    );
    const fromPkcs8 = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', EC_PKCS8, SESSION_ID)
    );

    expect(Buffer.from(fromSec1.publicKeyBlob).equals(fromOpenSSH.publicKeyBlob)).toBe(true);
    expect(Buffer.from(fromPkcs8.publicKeyBlob).equals(fromOpenSSH.publicKeyBlob)).toBe(true);
    expect(fromSec1.requestAlgo).toBe('ecdsa-sha2-nistp256');
    expect(fromPkcs8.requestAlgo).toBe('ecdsa-sha2-nistp256');
  });

  it('SEC1 签名可通过 blob 内公钥点（raw EC）验证', async () => {
    const parsed = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', EC_SEC1, SESSION_ID)
    );

    // blob: string("ecdsa-sha2-nistp256") + string("nistp256") + string(Q)
    let off = 0;
    const readStr = () => {
      const len = readUint32(parsed.publicKeyBlob, off);
      const data = parsed.publicKeyBlob.subarray(off + 4, off + 4 + len);
      off += 4 + len;
      return data;
    };
    expect(new TextDecoder().decode(readStr())).toBe('ecdsa-sha2-nistp256');
    readStr(); // curve name
    const q = readStr();
    expect(q[0]).toBe(0x04); // 非压缩点

    // SSH ECDSA 签名内容 = mpint(r) || mpint(s)（RFC 5656），需还原为定宽 r||s 再验签。
    // 注意 sshMPInt 会对高位字节 ≥0x80 的分量前置 0x00 符号填充（~50% 概率），
    // 必须剥除，否则既错位覆写 r 末字节（验签 false）又会触发负偏移 RangeError。
    const sigBlob = parsed.signatureValue;
    let so = 0;
    const readMpint = () => {
      const len = readUint32(sigBlob, so);
      let d = sigBlob.subarray(so + 4, so + 4 + len);
      so += 4 + len;
      if (d.length > 32 && d[0] === 0) {
        d = d.subarray(1);
      }
      return d;
    };
    const r = readMpint();
    const s = readMpint();
    const raw = new Uint8Array(64); // P-256：r/s 各 32 字节定宽
    raw.set(r, 32 - r.length);
    raw.set(s, 64 - s.length);

    const pubKey = await crypto.subtle.importKey('raw', q, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify'
    ]);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      raw,
      parsed.dataToSign
    );
    expect(ok).toBe(true);
  });

  it('SEC1 缺失公钥点时经 JWK 推导公钥，blob 仍一致', async () => {
    // 从夹具提取组件，手工重打包为不含 [1] 公钥点的最小 SEC1 DER
    const ec = parseSec1Ec(new Uint8Array(Buffer.from(EC_SEC1.split('\n').filter((l) => !l.startsWith('-----')).join(''), 'base64')));
    expect(ec.kind).toBe('ec');

    // P-256 曲线 OID: 1.2.840.10045.3.1.7
    const derTlv = (tag: number, content: Uint8Array): Uint8Array => {
      const head = tag === 0x30 || tag === 0xa0 ? [tag, content.length] : [tag, content.length];
      return new Uint8Array([...head, ...content]);
    };
    const inner = new Uint8Array([
      ...derTlv(0x02, new Uint8Array([1])), // version 1
      ...derTlv(0x04, ec.privateKey), // privateKey
      ...derTlv(0xa0, derTlv(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]))), // [0] P-256 曲线 OID 1.2.840.10045.3.1.7
    ]);
    const sec1NoPub = new Uint8Array(derTlv(0x30, inner));
    const pem =
      '-----BEGIN EC PRIVATE KEY-----\n' +
      (Buffer.from(sec1NoPub).toString('base64').replace(/(.{64})/g, '$1\n')) +
      '\n-----END EC PRIVATE KEY-----';

    const parsed = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', pem, SESSION_ID)
    );
    const reference = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', EC_OPENSSH, SESSION_ID)
    );
    expect(Buffer.from(parsed.publicKeyBlob).equals(reference.publicKeyBlob)).toBe(true);
  });
});

describe('多格式私钥导入 — Ed25519（PKCS#8）', () => {
  it('PKCS#8 编码产出与 OpenSSH 一致的公钥 blob，且签名可验证', async () => {
    const fromOpenSSH = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', ED25519_OPENSSH, SESSION_ID)
    );
    const fromPkcs8 = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', ED25519_PKCS8, SESSION_ID)
    );

    expect(Buffer.from(fromPkcs8.publicKeyBlob).equals(fromOpenSSH.publicKeyBlob)).toBe(true);
    expect(fromPkcs8.requestAlgo).toBe('ssh-ed25519');

    // blob: string("ssh-ed25519") + string(pub 32B)
    let off = 0;
    const readStr = () => {
      const len = readUint32(fromPkcs8.publicKeyBlob, off);
      const data = fromPkcs8.publicKeyBlob.subarray(off + 4, off + 4 + len);
      off += 4 + len;
      return data;
    };
    readStr(); // key type
    const pub = readStr();

    const pubKey = await crypto.subtle.importKey('raw', pub, 'Ed25519', false, ['verify']);
    const ok = await crypto.subtle.verify('Ed25519', pubKey, fromPkcs8.signatureValue, fromPkcs8.dataToSign);
    expect(ok).toBe(true);
  });
});

describe('私钥粘贴误用与容错', () => {
  it('污染前缀的标记行不影响解析（回归：TERNSSH-----BEGIN ...）', async () => {
    const polluted = 'xxx说明文字-----BEGIN OPENSSH PRIVATE KEY-----\n' +
      RSA_OPENSSH.split('\n').slice(1, -1).join('\n') +
      '\n-----END OPENSSH PRIVATE KEY-----';
    const fromPolluted = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', polluted, SESSION_ID)
    );
    const fromClean = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', RSA_OPENSSH, SESSION_ID)
    );
    expect(Buffer.from(fromPolluted.publicKeyBlob).equals(fromClean.publicKeyBlob)).toBe(true);
  });

  it('裸 Base64 正文（无 PEM 标记）兼容解析', async () => {
    const bare = RSA_PKCS8.split('\n')
      .filter((l) => !l.startsWith('-----'))
      .join('');
    const fromBare = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', bare, SESSION_ID)
    );
    const reference = parseRequest(
      await SSHAuth.buildPublicKeyAuthRequest('testuser', RSA_PKCS8, SESSION_ID)
    );
    expect(Buffer.from(fromBare.publicKeyBlob).equals(reference.publicKeyBlob)).toBe(true);
  });

  it('公钥 PEM 误贴 → 指向性提示', async () => {
    await expect(
      SSHAuth.buildPublicKeyAuthRequest('testuser', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', SESSION_ID)
    ).rejects.toThrow(/公钥/);
  });

  it('OpenSSH 公钥行误贴 → 指向性提示', async () => {
    const pubLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample user@host';
    await expect(SSHAuth.buildPublicKeyAuthRequest('testuser', pubLine, SESSION_ID)).rejects.toThrow(/公钥/);
  });

  it('X.509 证书误贴 → 指向性提示', async () => {
    await expect(
      SSHAuth.buildPublicKeyAuthRequest(
        'testuser',
        '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
        SESSION_ID
      )
    ).rejects.toThrow(/证书/);
  });

  it('PuTTY PPK → 明确不支持与导出指引', async () => {
    const ppk = 'PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none\nComment: test\n';
    await expect(SSHAuth.buildPublicKeyAuthRequest('testuser', ppk, SESSION_ID)).rejects.toThrow(/PuTTY/);
  });

  it('传统口令加密 PEM（Proc-Type）→ 指向性提示', async () => {
    const encryptedPem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: DES-EDE3-CBC,0123456789ABCDEF',
      '',
      'AAAA',
      '-----END RSA PRIVATE KEY-----'
    ].join('\n');
    await expect(SSHAuth.buildPublicKeyAuthRequest('testuser', encryptedPem, SESSION_ID)).rejects.toThrow(/加密/);
  });

  it('PKCS#8 加密封装（ENCRYPTED PRIVATE KEY）→ 指向性提示', async () => {
    await expect(
      SSHAuth.buildPublicKeyAuthRequest(
        'testuser',
        '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----',
        SESSION_ID
      )
    ).rejects.toThrow(/加密私钥暂不支持/);
  });

  it('标记内非 Base64 垃圾 → 友好错误而非浏览器原生异常', async () => {
    const broken =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nSomethings\n-----END OPENSSH PRIVATE KEY-----';
    await expect(SSHAuth.buildPublicKeyAuthRequest('testuser', broken, SESSION_ID)).rejects.toThrow(/Base64|私钥/);
  });

  it('PKCS#8 封装的垃圾内容 → 结构化 DER 错误', async () => {
    await expect(
      SSHAuth.buildPublicKeyAuthRequest(
        'testuser',
        '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
        SESSION_ID
      )
    ).rejects.toThrow(DerError);
  });
});
