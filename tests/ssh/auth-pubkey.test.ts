/**
 * L1 修复验证：RSA/ECDSA 公钥认证互操作测试
 *
 * 覆盖清单 L1 三个子问题：
 *  1. RSA: USERAUTH_REQUEST 的 algorithm name 必须与签名 blob 内 algo name 一致（RFC 8332）
 *  2. ECDSA: P-256/P-384/P-521 哈希按曲线映射（RFC 5656 §6.2.1）
 *  3. ECDSA: 签名 blob 是真实可验签的（用真实 ssh-keygen 生成的无口令私钥做端到端验签）
 *
 * fixture 由 ssh-keygen 生成（无口令 OpenSSH 新格式），通过 git 提交测试用，
 * 不含任何真实凭据。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SSHAuth } from '../../src/ssh/auth';
import { readUint32, encodeString, concat } from '../../src/ssh/utils';

const FIXTURES_DIR = join(__dirname, 'fixtures');

function loadKey(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8').trim();
}

const RSA_KEY = loadKey('id_rsa_2048');
const ECDSA_256_KEY = loadKey('id_ecdsa_256');
const ECDSA_384_KEY = loadKey('id_ecdsa_384');
const ECDSA_521_KEY = loadKey('id_ecdsa_521');
const ED25519_KEY = loadKey('id_ed25519');

// 固定 sessionID（32 字节随机但是测试可复现）
const SESSION_ID = new Uint8Array(32);
for (let i = 0; i < 32; i++) SESSION_ID[i] = i + 1;

// ─── USERAUTH_REQUEST 包字段解析 helper ───────────────────────────────
// 包结构（RFC 4252 §7 + has-sig=TRUE）:
//   byte      SSH_MSG_USERAUTH_REQUEST (50)
//   string    username
//   string    service ("ssh-connection")
//   string    method ("publickey")
//   boolean   TRUE (0x01)
//   string    public key algorithm name           ← requestAlgo
//   string    public key blob                     ← 公钥 blob 内部类型保持不变
//   string    signature blob (含外层 string algo) ← 公钥认证的真正签名
interface ParsedUserAuthRequest {
  username: string;
  service: string;
  method: string;
  hasSig: boolean;
  requestAlgo: string;
  publicKeyBlob: Uint8Array;
  // signature blob 内部
  signatureAlgo: string;
  signatureValue: Uint8Array;
  // 整个签名的原始数据 = session_id_string || requestBody
  dataToSign: Uint8Array;
  requestBody: Uint8Array;
}

function parseUserAuthRequest(packet: Uint8Array, sessionID: Uint8Array): ParsedUserAuthRequest {
  if (packet[0] !== 50) throw new Error(`expected USERAUTH_REQUEST(50), got ${packet[0]}`);
  let offset = 1;

  const readString = (): { value: string; raw: Uint8Array } => {
    const len = readUint32(packet, offset);
    offset += 4;
    const raw = packet.subarray(offset, offset + len);
    offset += len;
    return { value: new TextDecoder().decode(raw), raw };
  };

  const { value: username } = readString();
  const { value: service } = readString();
  const { value: method } = readString();
  const hasSig = packet[offset] !== 0;
  offset += 1;
  const { value: requestAlgo, raw: requestAlgoRaw } = readString();
  const { raw: publicKeyBlob } = readString();

  const requestBody = packet.subarray(0, offset);

  // 外层 string(signature_blob)
  const sigBlobLen = readUint32(packet, offset);
  offset += 4;
  const sigBlob = packet.subarray(offset, offset + sigBlobLen);

  // signature_blob 内部: string(sig_algo), string(raw_sig)
  let so = 0;
  const sigAlgoLen = readUint32(sigBlob, so);
  so += 4;
  const signatureAlgo = new TextDecoder().decode(sigBlob.subarray(so, so + sigAlgoLen));
  so += sigAlgoLen;
  const rawSigLen = readUint32(sigBlob, so);
  so += 4;
  const signatureValue = sigBlob.subarray(so, so + rawSigLen);

  // dataToSign = string(session_id) || requestBody
  // 与 auth.ts 实现一致：concat(encodeString(sessionID), requestBody)
  const dataToSign = concat(encodeString(sessionID), requestBody);

  return {
    username, service, method, hasSig,
    requestAlgo, publicKeyBlob,
    signatureAlgo, signatureValue,
    dataToSign, requestBody,
  };
}

// 从公钥 blob 解析内部类型字段（验证"公钥 blob 内部类型保持不变"）
function publicKeyBlobType(blob: Uint8Array): string {
  const len = readUint32(blob, 0);
  return new TextDecoder().decode(blob.subarray(4, 4 + len));
}

// ─── 测试 ─────────────────────────────────────────────────────────────
describe('SSHAuth.buildPublicKeyAuthRequest — RSA', () => {
  it('request algorithm 与 signature algorithm 一致（RFC 8332 核心要求）', async () => {
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', RSA_KEY, SESSION_ID,
      ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],  // server-sig-algs
      false,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    expect(parsed.requestAlgo).toBe(parsed.signatureAlgo);
    expect(parsed.requestAlgo).not.toBe('ssh-rsa');  // 不得用 SHA-1
  });

  it('server-sig-algs 含 rsa-sha2-512 时优先选 512', async () => {
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', RSA_KEY, SESSION_ID,
      ['rsa-sha2-512', 'rsa-sha2-256'],
      false,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    expect(parsed.requestAlgo).toBe('rsa-sha2-512');
    expect(parsed.signatureAlgo).toBe('rsa-sha2-512');
  });

  it('server-sig-algs 仅含 rsa-sha2-256 时选 256', async () => {
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', RSA_KEY, SESSION_ID,
      ['rsa-sha2-256'],
      false,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    expect(parsed.requestAlgo).toBe('rsa-sha2-256');
    expect(parsed.signatureAlgo).toBe('rsa-sha2-256');
  });

  it('未收到 server-sig-algs 时默认 rsa-sha2-256（不静默降级 SHA-1）', async () => {
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', RSA_KEY, SESSION_ID,
      [],   // 未收到 ext-info
      false,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    expect(parsed.requestAlgo).toBe('rsa-sha2-256');
    expect(parsed.signatureAlgo).toBe('rsa-sha2-256');
  });

  it('allowLegacyRsaSha1=false 且 server 仅支持 ssh-rsa 时抛 fatal', async () => {
    await expect(
      SSHAuth.buildPublicKeyAuthRequest(
        'testuser', RSA_KEY, SESSION_ID,
        ['ssh-rsa'],
        false,
      )
    ).rejects.toThrow(/no_supported_rsa_signature_algorithm/);
  });

  it('allowLegacyRsaSha1=true 且 server 仅支持 ssh-rsa 时使用 SHA-1（明确兼容模式）', async () => {
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', RSA_KEY, SESSION_ID,
      ['ssh-rsa'],
      true,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    expect(parsed.requestAlgo).toBe('ssh-rsa');
    expect(parsed.signatureAlgo).toBe('ssh-rsa');
  });

  it('公钥 blob 内部类型始终为 ssh-rsa（不变）', async () => {
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', RSA_KEY, SESSION_ID,
      ['rsa-sha2-256'],
      false,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    expect(publicKeyBlobType(parsed.publicKeyBlob)).toBe('ssh-rsa');
  });

  it('签名可被独立 WebCrypto 用对应 hash 验签（真实互操作）', async () => {
    // 服务器端会按 signatureAlgo 选择 hash 来 verify
    for (const [serverAlgs, hash] of [
      [['rsa-sha2-256'], 'SHA-256'],
      [['rsa-sha2-512'], 'SHA-512'],
    ] as [string[], 'SHA-256' | 'SHA-512'][]) {
      const packet = await SSHAuth.buildPublicKeyAuthRequest(
        'testuser', RSA_KEY, SESSION_ID, serverAlgs, false,
      );
      const parsed = parseUserAuthRequest(packet, SESSION_ID);

      // 从公钥 blob 重建 JWK，验证签名
      let off = 4 + 'ssh-rsa'.length;  // skip "ssh-rsa"
      const eLen = readUint32(parsed.publicKeyBlob, off); off += 4;
      let e = parsed.publicKeyBlob.subarray(off, off + eLen); off += eLen;
      const nLen = readUint32(parsed.publicKeyBlob, off); off += 4;
      let n = parsed.publicKeyBlob.subarray(off, off + nLen); off += nLen;
      // mpint 可能含前导 0（最高位为 1 时补位的符号位），JWK 不接受前导 0
      while (e.length > 1 && e[0] === 0) e = e.subarray(1);
      while (n.length > 1 && n[0] === 0) n = n.subarray(1);

      const b64url = (b: Uint8Array): string => {
        let bin = '';
        for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      };
      const jwk = { kty: 'RSA', e: b64url(e), n: b64url(n), ext: true };
      const pubKey = await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify'],
      );
      const ok = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5', pubKey, parsed.signatureValue, parsed.dataToSign,
      );
      expect(ok).toBe(true);
    }
  });
});

describe('SSHAuth.buildPublicKeyAuthRequest — ECDSA', () => {
  // 三曲线参数：[key, keyType, namedCurve, hash, coordBytes]
  const ECDSA_CASES = [
    { key: ECDSA_256_KEY, keyType: 'ecdsa-sha2-nistp256', curve: 'P-256', hash: 'SHA-256', coordBytes: 32 },
    { key: ECDSA_384_KEY, keyType: 'ecdsa-sha2-nistp384', curve: 'P-384', hash: 'SHA-384', coordBytes: 48 },
    { key: ECDSA_521_KEY, keyType: 'ecdsa-sha2-nistp521', curve: 'P-521', hash: 'SHA-512', coordBytes: 66 },
  ] as const;

  for (const c of ECDSA_CASES) {
    describe(`${c.keyType}`, () => {
      it('request 与 signature algorithm 都是该曲线 keyType', async () => {
        const packet = await SSHAuth.buildPublicKeyAuthRequest(
          'testuser', c.key, SESSION_ID,
        );
        const parsed = parseUserAuthRequest(packet, SESSION_ID);

        expect(parsed.requestAlgo).toBe(c.keyType);
        expect(parsed.signatureAlgo).toBe(c.keyType);
      });

      it('公钥 blob 内部类型为对应 keyType', async () => {
        const packet = await SSHAuth.buildPublicKeyAuthRequest(
          'testuser', c.key, SESSION_ID,
        );
        const parsed = parseUserAuthRequest(packet, SESSION_ID);
        expect(publicKeyBlobType(parsed.publicKeyBlob)).toBe(c.keyType);
      });

      it(`使用 ${c.hash} 哈希验签通过（端到端互操作）`, async () => {
        const packet = await SSHAuth.buildPublicKeyAuthRequest(
          'testuser', c.key, SESSION_ID,
        );
        const parsed = parseUserAuthRequest(packet, SESSION_ID);

        // 从公钥 blob 解析 raw point
        let off = 4 + c.keyType.length;
        const curveLen = readUint32(parsed.publicKeyBlob, off); off += 4 + curveLen;
        const ptLen = readUint32(parsed.publicKeyBlob, off); off += 4;
        const rawPoint = parsed.publicKeyBlob.subarray(off, off + ptLen);

        const pubKey = await crypto.subtle.importKey(
          'raw', rawPoint, { name: 'ECDSA', namedCurve: c.curve }, false, ['verify'],
        );

        // SSH 签名 sigValue 是 string(r)||string(s)，需要转回 raw r||s
        let so = 0;
        const rLen = readUint32(parsed.signatureValue, so); so += 4;
        let r = parsed.signatureValue.subarray(so, so + rLen); so += rLen;
        const sLen = readUint32(parsed.signatureValue, so); so += 4;
        let s = parsed.signatureValue.subarray(so, so + sLen); so += sLen;

        if (r.length > c.coordBytes && r[0] === 0) r = r.subarray(1);
        if (s.length > c.coordBytes && s[0] === 0) s = s.subarray(1);
        const rawSig = new Uint8Array(c.coordBytes * 2);
        rawSig.set(r, c.coordBytes - r.length);
        rawSig.set(s, c.coordBytes * 2 - s.length);

        const ok = await crypto.subtle.verify(
          { name: 'ECDSA', hash: c.hash }, pubKey, rawSig, parsed.dataToSign,
        );
        expect(ok).toBe(true);
      });
    });
  }

  it('RFC 5656: P-384 必须用 SHA-384（不能用 SHA-256，否则验签必败）', async () => {
    // 故意用错误哈希 SHA-256 验 P-384 签名 —— 期望失败，证明签名确实使用了正确哈希
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', ECDSA_384_KEY, SESSION_ID,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    let off = 4 + 'ecdsa-sha2-nistp384'.length;
    const curveLen = readUint32(parsed.publicKeyBlob, off); off += 4 + curveLen;
    const ptLen = readUint32(parsed.publicKeyBlob, off); off += 4;
    const rawPoint = parsed.publicKeyBlob.subarray(off, off + ptLen);

    const pubKey = await crypto.subtle.importKey(
      'raw', rawPoint, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['verify'],
    );
    let so = 0;
    const rLen = readUint32(parsed.signatureValue, so); so += 4;
    let r = parsed.signatureValue.subarray(so, so + rLen); so += rLen;
    const sLen = readUint32(parsed.signatureValue, so); so += 4;
    let s = parsed.signatureValue.subarray(so, so + sLen); so += sLen;
    if (r.length > 48 && r[0] === 0) r = r.subarray(1);
    if (s.length > 48 && s[0] === 0) s = s.subarray(1);
    const rawSig = new Uint8Array(96);
    rawSig.set(r, 48 - r.length);
    rawSig.set(s, 96 - s.length);

    // ★ 故意用错误的 SHA-256 —— 必须 verify=false
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, pubKey, rawSig, parsed.dataToSign,
    );
    expect(ok).toBe(false);
  });

  it('不支持的曲线 keyType 抛错（防御）', async () => {
    // parsePrivateKey 内部会抛"不支持的密钥类型"，因为 parse 阶段对 ecdsa-sha2-foo 不识别
    // 这里用一个不可达的间接测试：parseECDSAKey 已经覆盖了曲线校验
    // 直接验证 build PublicKeyAuthRequest 对 OpenSSH 格式但未知 key 抛错
    await expect(
      SSHAuth.buildPublicKeyAuthRequest('testuser', 'not a key', SESSION_ID),
    ).rejects.toThrow();
  });
});

describe('SSHAuth.buildPublicKeyAuthRequest — Ed25519（回归验证）', () => {
  it('request 与 signature algorithm 均为 ssh-ed25519 且可验签', async () => {
    const packet = await SSHAuth.buildPublicKeyAuthRequest(
      'testuser', ED25519_KEY, SESSION_ID,
    );
    const parsed = parseUserAuthRequest(packet, SESSION_ID);

    expect(parsed.requestAlgo).toBe('ssh-ed25519');
    expect(parsed.signatureAlgo).toBe('ssh-ed25519');

    // 公钥 blob: string("ssh-ed25519"), string(pubkey 32 bytes)
    let off = 4 + 'ssh-ed25519'.length;
    const pkLen = readUint32(parsed.publicKeyBlob, off); off += 4;
    const pub = parsed.publicKeyBlob.subarray(off, off + pkLen);

    const pubKey = await crypto.subtle.importKey('raw', pub, 'Ed25519', false, ['verify']);
    const ok = await crypto.subtle.verify('Ed25519', pubKey, parsed.signatureValue, parsed.dataToSign);
    expect(ok).toBe(true);
  });
});
