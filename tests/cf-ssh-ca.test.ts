import { describe, expect, it, vi } from 'vitest';
import {
  generateEcdsaKeyPair,
  requestCloudflareSshCertificate,
} from '../frontend/src/cf-ssh-ca';
import { SSHAuth } from '../src/ssh/auth';
import { readUint32 } from '../src/ssh/utils';
import { createUserCertificate, createSigningKey } from './ssh/host-certificate-fixture';
import { encodeString } from '../src/ssh/utils';

describe('frontend/src/cf-ssh-ca', () => {
  it('generates valid ECDSA P-256 OpenSSH public key and PKCS#8 PEM private key', async () => {
    const { privateKeyPEM, publicKeyOpenSSH } = await generateEcdsaKeyPair();

    // 格式检查
    expect(privateKeyPEM).toContain('-----BEGIN PRIVATE KEY-----');
    expect(privateKeyPEM).toContain('-----END PRIVATE KEY-----');
    expect(publicKeyOpenSSH.startsWith('ecdsa-sha2-nistp256 ')).toBe(true);
    expect(publicKeyOpenSSH.endsWith(' cf-ssh-ca-session')).toBe(true);

    // 能被服务端的 SSHAuth.parsePrivateKey 正常解析为 ecdsa-sha2-nistp256
    const sessionID = new Uint8Array(32).fill(0x11);
    const req = await SSHAuth.buildPublicKeyAuthRequest('testuser', privateKeyPEM, sessionID);
    expect(req[0]).toBe(50);
  });

  it('requestCloudflareSshCertificate posts to sign endpoint and returns credentials', async () => {
    const mockCert = 'ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAMOCKCERT user@company';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        certificate: mockCert,
        id: 'mock-id-123',
        expires_at: '2026-05-18T12:00:00Z',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const creds = await requestCloudflareSshCertificate('myteam', 'mock.token');
    expect(creds.certificate).toBe(mockCert);
    expect(creds.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(creds.expiresAt).toBe('2026-05-18T12:00:00Z');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/cf-ssh-ca/sign',
      expect.objectContaining({
        method: 'POST',
      })
    );

    vi.unstubAllGlobals();
  });

  it('requestCloudflareSshCertificate throws on API error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: '未检测到身份凭据' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(requestCloudflareSshCertificate('myteam')).rejects.toThrow('未检测到身份凭据');

    vi.unstubAllGlobals();
  });

  it('builds authenticating request using generated ECDSA key and signed user certificate', async () => {
    // 1. 生成 ECDSA P-256 密钥对
    const { privateKeyPEM, publicKeyOpenSSH } = await generateEcdsaKeyPair();

    // 2. 模拟 CA 针对该公钥签署 OpenSSH 证书
    const b64 = publicKeyOpenSSH.split(' ')[1];
    const pubBlob = new Uint8Array(Buffer.from(b64, 'base64'));
    const ca = await createSigningKey('ssh-ed25519');
    const hostKey = {
      algorithm: 'ecdsa-sha2-nistp256',
      blob: pubBlob,
      sign: async () => new Uint8Array(0),
    };

    const { blob: certBlob } = await createUserCertificate(
      { principals: encodeString('root') },
      { host: hostKey, ca }
    );
    const sessionID = new Uint8Array(32).fill(0x33);

    // 3. 构建公钥认证报文并校验
    const req = await SSHAuth.buildPublicKeyAuthRequest(
      'root',
      privateKeyPEM,
      sessionID,
      undefined,
      false,
      certBlob
    );

    expect(req[0]).toBe(50);
    let offset = 1;
    // username
    const uLen = readUint32(req, offset);
    offset += 4 + uLen;
    // service
    const sLen = readUint32(req, offset);
    offset += 4 + sLen;
    // method
    const mLen = readUint32(req, offset);
    offset += 4 + mLen;
    // hasSig (1)
    expect(req[offset++]).toBe(1);
    // requestAlgo must be ecdsa-sha2-nistp256-cert-v01@openssh.com
    const algoLen = readUint32(req, offset);
    offset += 4;
    const algo = new TextDecoder().decode(req.subarray(offset, offset + algoLen));
    expect(algo).toBe('ecdsa-sha2-nistp256-cert-v01@openssh.com');
  });
});
