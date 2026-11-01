import { describe, expect, it } from 'vitest';
import { SSHAuth } from '../../src/ssh/auth';
import { concat, encodeString, readUint32 } from '../../src/ssh/utils';
import {
  extractPrivateKeyAndCertificate,
  parseOpenSshUserCertificate,
  SSH_CERT_TYPE_HOST,
  SSH_CERT_TYPE_USER,
} from '../../src/ssh/user-cert';
import {
  certificateKeys,
  createSigningKey,
  createUserCertificate,
} from './host-certificate-fixture';

// 真实的 OpenSSH Ed25519 测试密钥对
const ED25519_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBP39pG2T2U3Jg+z0/2x2Vj/gE3K4g7u3f9k3Xy2q2fLwAAAJgAAACYA
AAAC3NzaC1lZDI1NTE5AAAAIE/f2kbZPZTcmD7PT/bHZWfsATcriDu7d/2TdfLarr8vAA
AAIA8fG04tO3/U5Fw0tY2b9K/p0QG/N9g2E4sK9m/7+j3lAAAAEHRlc3RAZXhhbXBsZS
5jb20BAg==
-----END OPENSSH PRIVATE KEY-----`;

describe('user-cert', () => {
  describe('extractPrivateKeyAndCertificate', () => {
    it('returns pure private key unchanged when no certificate line is present', () => {
      const res = extractPrivateKeyAndCertificate(ED25519_PRIVATE_KEY);
      expect(res.privateKey).toBe(ED25519_PRIVATE_KEY);
      expect(res.certificate).toBeUndefined();
    });

    it('extracts certificate line when appended after private key PEM', () => {
      const certLine = 'ssh-ed25519-cert-v01@openssh.com AAAAHHNzaC1lZDI1NTE5-fake-cert user@example.com';
      const combined = `${ED25519_PRIVATE_KEY}\n${certLine}`;
      const res = extractPrivateKeyAndCertificate(combined);
      expect(res.privateKey).toBe(ED25519_PRIVATE_KEY);
      expect(res.certificate).toBe(certLine);
    });
  });

  describe('parseOpenSshUserCertificate', () => {
    it('parses valid user certificate and validates principals and key blob', async () => {
      const { host, ca } = await certificateKeys();
      const now = 1700000000000;
      const { blob } = await createUserCertificate(
        {
          keyId: 'alice@company.com',
          principals: concat(encodeString('alice'), encodeString('root')),
          validAfter: 1600000000n,
          validBefore: 1800000000n,
        },
        { host, ca }
      );

      const parsed = parseOpenSshUserCertificate(blob, now);
      expect(parsed.type).toBe(SSH_CERT_TYPE_USER);
      expect(parsed.keyId).toBe('alice@company.com');
      expect(parsed.principals).toEqual(['alice', 'root']);
      expect(parsed.validAfter).toBe(1600000000n);
      expect(parsed.validBefore).toBe(1800000000n);
      expect(parsed.underlyingKeyType).toBe('ssh-ed25519');
      expect(parsed.certType).toBe('ssh-ed25519-cert-v01@openssh.com');
      expect(parsed.publicKeyBlob).toEqual(host.blob);
      expect(parsed.caPublicKeyBlob).toEqual(ca.blob);
    });

    it('decodes single-line certificate string format', async () => {
      const { host, ca } = await certificateKeys();
      const { blob } = await createUserCertificate({}, { host, ca });
      const b64 = btoa(String.fromCharCode(...blob));
      const line = `ssh-ed25519-cert-v01@openssh.com ${b64} auto-minted-user-cert`;

      const parsed = parseOpenSshUserCertificate(line);
      expect(parsed.type).toBe(SSH_CERT_TYPE_USER);
      expect(parsed.rawBlob).toEqual(blob);
    });

    it('rejects host certificate with clear error message', async () => {
      const { host, ca } = await certificateKeys();
      const { blob } = await createUserCertificate({ type: SSH_CERT_TYPE_HOST }, { host, ca });
      expect(() => parseOpenSshUserCertificate(blob)).toThrow('检测到 SSH 主机证书');
    });

    it('rejects expired user certificate', async () => {
      const { host, ca } = await certificateKeys();
      const { blob } = await createUserCertificate(
        {
          validAfter: 100n,
          validBefore: 200n,
        },
        { host, ca }
      );

      // now is 300 seconds
      expect(() => parseOpenSshUserCertificate(blob, 300 * 1000)).toThrow('SSH 证书已过期');
    });

    it('rejects not-yet-valid user certificate', async () => {
      const { host, ca } = await certificateKeys();
      const { blob } = await createUserCertificate(
        {
          validAfter: 500n,
          validBefore: 600n,
        },
        { host, ca }
      );

      // now is 400 seconds
      expect(() => parseOpenSshUserCertificate(blob, 400 * 1000)).toThrow('SSH 证书尚未生效');
    });

    it('rejects truncated certificate blob', () => {
      expect(() => parseOpenSshUserCertificate(new Uint8Array([0, 0, 0, 5]))).toThrow();
    });
  });

  describe('SSHAuth.buildPublicKeyAuthRequest with certificate', () => {
    it('builds authenticating request using user certificate and matches matching private key', async () => {
      const { host, ca } = await certificateKeys();
      const { blob } = await createUserCertificate({}, { host, ca });

      // 生成一对合法的另一个 Ed25519 密钥
      const ed25519Pair = (await crypto.subtle.generateKey('Ed25519', true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      const pkcs8Der = new Uint8Array(
        (await crypto.subtle.exportKey('pkcs8', ed25519Pair.privateKey)) as ArrayBuffer
      );
      const pkcs8B64 = btoa(String.fromCharCode(...pkcs8Der));
      const privPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8B64}\n-----END PRIVATE KEY-----`;

      // If we pair host's cert with a different key, it must reject
      const sessionID = new Uint8Array(32).fill(0xaa);
      await expect(
        SSHAuth.buildPublicKeyAuthRequest(
          'testuser',
          privPem,
          sessionID,
          undefined,
          false,
          blob
        )
      ).rejects.toThrow('私钥与证书不匹配');
    });

    it('successfully packs certificate into requestAlgo and public key blob when key matches', async () => {
      // 1. 生成一对新的 ed25519 密钥
      const ed25519Pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
      const rawPub = new Uint8Array((await crypto.subtle.exportKey('raw', ed25519Pair.publicKey)) as ArrayBuffer);
      const pkcs8Der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', ed25519Pair.privateKey)) as ArrayBuffer);
      const pkcs8B64 = btoa(String.fromCharCode(...pkcs8Der));
      const privPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8B64}\n-----END PRIVATE KEY-----`;

      // 2. 构造基于该公钥签发的有效证书
      const ca = await createSigningKey('ssh-ed25519');
      const hostSigningKey = {
        algorithm: 'ssh-ed25519',
        blob: concat(encodeString('ssh-ed25519'), encodeString(rawPub)),
        sign: async (data: Uint8Array) => concat(
          encodeString('ssh-ed25519'),
          encodeString(new Uint8Array(await crypto.subtle.sign('Ed25519', ed25519Pair.privateKey, data)))
        ),
      };

      const { blob: certBlob } = await createUserCertificate(
        { principals: encodeString('alice') },
        { host: hostSigningKey, ca }
      );

      // 3. 构建公钥认证报文
      const sessionID = new Uint8Array(32).fill(0x55);
      const authPacket = await SSHAuth.buildPublicKeyAuthRequest(
        'alice',
        privPem,
        sessionID,
        undefined,
        false,
        certBlob
      );

      // 4. 校验报文格式：
      // [0] = 50 (SSH_MSG_USERAUTH_REQUEST)
      expect(authPacket[0]).toBe(50);
      let offset = 1;

      // username: string
      const userLen = readUint32(authPacket, offset);
      offset += 4;
      const user = new TextDecoder().decode(authPacket.subarray(offset, offset + userLen));
      offset += userLen;
      expect(user).toBe('alice');

      // service: string ('ssh-connection')
      const servLen = readUint32(authPacket, offset);
      offset += 4;
      const serv = new TextDecoder().decode(authPacket.subarray(offset, offset + servLen));
      offset += servLen;
      expect(serv).toBe('ssh-connection');

      // method: string ('publickey')
      const methLen = readUint32(authPacket, offset);
      offset += 4;
      const meth = new TextDecoder().decode(authPacket.subarray(offset, offset + methLen));
      offset += methLen;
      expect(meth).toBe('publickey');

      // hasSignature: boolean (1)
      expect(authPacket[offset++]).toBe(1);

      // requestAlgo: string ('ssh-ed25519-cert-v01@openssh.com')
      const algoLen = readUint32(authPacket, offset);
      offset += 4;
      const algo = new TextDecoder().decode(authPacket.subarray(offset, offset + algoLen));
      offset += algoLen;
      expect(algo).toBe('ssh-ed25519-cert-v01@openssh.com');

      // pubKeyBlob: string (必须等于 certBlob)
      const keyBlobLen = readUint32(authPacket, offset);
      offset += 4;
      const extractedCertBlob = authPacket.subarray(offset, offset + keyBlobLen);
      offset += keyBlobLen;
      expect(extractedCertBlob).toEqual(certBlob);

      // signature: string (包含算法名 + 签名)
      const sigBlobLen = readUint32(authPacket, offset);
      offset += 4;
      expect(sigBlobLen).toBeGreaterThan(0);
      expect(offset + sigBlobLen).toBe(authPacket.length);
    });

    it('still sends a certificate when the username differs from its principals', async () => {
      const ed25519Pair = (await crypto.subtle.generateKey('Ed25519', true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      const rawPub = new Uint8Array(
        (await crypto.subtle.exportKey('raw', ed25519Pair.publicKey)) as ArrayBuffer
      );
      const pkcs8Der = new Uint8Array(
        (await crypto.subtle.exportKey('pkcs8', ed25519Pair.privateKey)) as ArrayBuffer
      );
      const privPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8Der))}\n-----END PRIVATE KEY-----`;

      const ca = await createSigningKey('ssh-ed25519');
      const hostSigningKey = {
        algorithm: 'ssh-ed25519',
        blob: concat(encodeString('ssh-ed25519'), encodeString(rawPub)),
        sign: async (data: Uint8Array) =>
          concat(
            encodeString('ssh-ed25519'),
            encodeString(
              new Uint8Array(await crypto.subtle.sign('Ed25519', ed25519Pair.privateKey, data))
            )
          ),
      };

      // principals 只有 alice。sshd 可以用 AuthorizedPrincipals 接受其他 Unix 用户，客户端不得提前拒绝。
      const { blob: certBlob } = await createUserCertificate(
        { principals: encodeString('alice') },
        { host: hostSigningKey, ca }
      );
      const sessionID = new Uint8Array(32).fill(0x55);

      const packet = await SSHAuth.buildPublicKeyAuthRequest(
        'root',
        privPem,
        sessionID,
        undefined,
        false,
        certBlob
      );
      expect(packet[0]).toBe(50);
    });

    it('supports combined private key and certificate text input', async () => {
      const ed25519Pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
      const rawPub = new Uint8Array((await crypto.subtle.exportKey('raw', ed25519Pair.publicKey)) as ArrayBuffer);
      const pkcs8Der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', ed25519Pair.privateKey)) as ArrayBuffer);
      const pkcs8B64 = btoa(String.fromCharCode(...pkcs8Der));
      const privPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8B64}\n-----END PRIVATE KEY-----`;

      const ca = await createSigningKey('ssh-ed25519');
      const hostSigningKey = {
        algorithm: 'ssh-ed25519',
        blob: concat(encodeString('ssh-ed25519'), encodeString(rawPub)),
        sign: async (data: Uint8Array) => concat(
          encodeString('ssh-ed25519'),
          encodeString(new Uint8Array(await crypto.subtle.sign('Ed25519', ed25519Pair.privateKey, data)))
        ),
      };

      const { blob: certBlob } = await createUserCertificate(
        { principals: encodeString('bob') },
        { host: hostSigningKey, ca }
      );
      const certLine = `ssh-ed25519-cert-v01@openssh.com ${btoa(String.fromCharCode(...certBlob))} auto-cert`;

      // 组合文本
      const combined = `${privPem}\n${certLine}`;
      const sessionID = new Uint8Array(32).fill(0x77);

      const authPacket = await SSHAuth.buildPublicKeyAuthRequest(
        'bob',
        combined,
        sessionID
      );

      expect(authPacket[0]).toBe(50);
      // 验证报文中算法为证书算法
      let offset = 1;
      const userLen = readUint32(authPacket, offset);
      offset += 4 + userLen;
      const servLen = readUint32(authPacket, offset);
      offset += 4 + servLen;
      const methLen = readUint32(authPacket, offset);
      offset += 4 + methLen;
      offset += 1; // hasSig
      const algoLen = readUint32(authPacket, offset);
      offset += 4;
      const algo = new TextDecoder().decode(authPacket.subarray(offset, offset + algoLen));
      expect(algo).toBe('ssh-ed25519-cert-v01@openssh.com');
    });
  });
});
