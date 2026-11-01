import { describe, expect, it, vi } from 'vitest';
import {
  extractAccessJwt,
  handleCloudflareSshCaSign,
  sanitizeTeamName,
  signSshCertificateWithCloudflare,
} from '../../src/worker/cf-ssh-ca';

describe('cf-ssh-ca', () => {
  describe('sanitizeTeamName', () => {
    it('accepts clean alphanumeric team names', () => {
      expect(sanitizeTeamName('my-team')).toBe('my-team');
      expect(sanitizeTeamName('Company123')).toBe('company123');
    });

    it('cleans full domain or URL inputs', () => {
      expect(sanitizeTeamName('my-team.cloudflareaccess.com')).toBe('my-team');
      expect(sanitizeTeamName('https://my-team.cloudflareaccess.com')).toBe('my-team');
      expect(sanitizeTeamName('http://my-team')).toBe('my-team');
    });

    it('rejects invalid or dangerous team names', () => {
      expect(() => sanitizeTeamName('')).toThrow();
      expect(() => sanitizeTeamName('bad/name')).toThrow();
      expect(() => sanitizeTeamName('team.with.dots')).toThrow();
      expect(() => sanitizeTeamName('a'.repeat(65))).toThrow();
    });
  });

  describe('extractAccessJwt', () => {
    it('extracts JWT from Cf-Access-Jwt-Assertion header', () => {
      const req = new Request('https://ssh.example.com', {
        headers: {
          'Cf-Access-Jwt-Assertion': 'fake.jwt.assertion',
        },
      });
      expect(extractAccessJwt(req)).toBe('fake.jwt.assertion');
    });

    it('extracts JWT from Cookie if header is missing', () => {
      const req = new Request('https://ssh.example.com', {
        headers: {
          Cookie: 'foo=bar; CF_Authorization=cookie.jwt.val; other=123',
        },
      });
      expect(extractAccessJwt(req)).toBe('cookie.jwt.val');
    });

    it('returns null if neither is present', () => {
      const req = new Request('https://ssh.example.com');
      expect(extractAccessJwt(req)).toBeNull();
    });
  });

  describe('signSshCertificateWithCloudflare', () => {
    it('sends proper payload and parses response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'test-key-id',
          certificate: 'ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAB3... user@test',
          expires_at: '2026-05-18T12:00:00Z',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const res = await signSshCertificateWithCloudflare(
        'myteam',
        'ecdsa-sha2-nistp256 AAAAE2... cf-key',
        'token.jwt'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://myteam.cloudflareaccess.com/cdn-cgi/access/cert_sign',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            public_key: 'ecdsa-sha2-nistp256 AAAAE2... cf-key',
            jwt: 'token.jwt',
            issuer: 'https://myteam.cloudflareaccess.com',
          }),
        })
      );
      expect(res.certificate).toBe(
        'ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAB3... user@test'
      );
      expect(res.id).toBe('test-key-id');

      vi.unstubAllGlobals();
    });

    it('rejects redirect response to protect credentials', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ Location: 'https://evil.example.com' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        signSshCertificateWithCloudflare('myteam', 'ecdsa-sha2-nistp256 AAAAE...', 'token.jwt')
      ).rejects.toThrow('重定向');

      vi.unstubAllGlobals();
    });

    it('handles error response and sanitizes sensitive tokens', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'bearer secret_jwt_12345 access denied' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        signSshCertificateWithCloudflare('myteam', 'ecdsa-sha2-nistp256 AAAAE...', 'token.jwt')
      ).rejects.toThrow('bearer [REDACTED] access denied');

      vi.unstubAllGlobals();
    });
  });

  describe('handleCloudflareSshCaSign', () => {
    it('rejects invalid json payload', async () => {
      const req = new Request('https://ssh.example.com/api/cf-ssh-ca/sign', {
        method: 'POST',
        body: 'invalid-json',
      });
      const resp = await handleCloudflareSshCaSign(req);
      expect(resp.status).toBe(400);
      const data = (await resp.json()) as any;
      expect(data.error).toBe('无效的 JSON 请求正文');
    });

    it('rejects missing public key', async () => {
      const req = new Request('https://ssh.example.com/api/cf-ssh-ca/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'myteam' }),
      });
      const resp = await handleCloudflareSshCaSign(req);
      expect(resp.status).toBe(400);
      const data = (await resp.json()) as any;
      expect(data.error).toBe('缺少或无效的 SSH 公钥');
    });

    it('rejects missing JWT when neither header nor body token provided', async () => {
      const req = new Request('https://ssh.example.com/api/cf-ssh-ca/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'myteam', publicKey: 'ecdsa-sha2-nistp256 AAAA...' }),
      });
      const resp = await handleCloudflareSshCaSign(req);
      expect(resp.status).toBe(401);
      const data = (await resp.json()) as any;
      expect(data.error).toContain('未检测到 Cloudflare Access 身份凭据');
    });

    it('rejects oversized JWT token', async () => {
      const req = new Request('https://ssh.example.com/api/cf-ssh-ca/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamName: 'myteam',
          publicKey: 'ecdsa-sha2-nistp256 AAAA...',
          token: 'a'.repeat(9000),
        }),
      });
      const resp = await handleCloudflareSshCaSign(req);
      expect(resp.status).toBe(400);
      const data = (await resp.json()) as any;
      expect(data.error).toContain('超出安全限制');
    });

    it('signs successfully when token provided in body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          certificate: 'ecdsa-sha2-nistp256-cert-v01@openssh.com AAAA... mock-cert',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const req = new Request('https://ssh.example.com/api/cf-ssh-ca/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamName: 'myteam',
          publicKey: 'ecdsa-sha2-nistp256 AAAA...',
          token: 'custom.jwt.token',
        }),
      });

      const resp = await handleCloudflareSshCaSign(req);
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as any;
      expect(data.certificate).toBe(
        'ecdsa-sha2-nistp256-cert-v01@openssh.com AAAA... mock-cert'
      );

      vi.unstubAllGlobals();
    });
  });
});
