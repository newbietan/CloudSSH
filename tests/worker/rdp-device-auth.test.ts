import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { initializeAccessIdentity } from '../../src/worker/auth';
import { ENROLL_MS, RdpAuthorityDO, registrationMessage, signDeviceScope, standbyMessage, verifyDeviceScope, verifyDeviceSignature } from '../../src/worker/rdp-device-auth';
import { handleRdp, type RdpAssets } from '../../src/worker/rdp-routes';

const profile = '12345678-1234-1234-1234-123456789abc';
const device = 'aaaaaaaa-2222-3333-4444-555555555555';
const url = 'https://desk.example/api/rdp/device/register';
const rand = 'c'.repeat(64);
const github = { GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' };
const fixture = (options?: Record<string, string>) => {
  const db = new Map<string, ArrayBuffer>();
  const txn = { get: async (key: string) => db.get(key), put: async (key: string, value: ArrayBuffer) => { db.set(key, value); } };
  const state = { storage: { transaction: <T>(callback: (t: typeof txn) => Promise<T>) => callback(txn) } } as unknown as DurableObjectState;
  let signer = new RdpAuthorityDO(state);
  const env = { ...github, ...options, RDP_AUTHORITY: { idFromName: (id: string) => id,
    get: () => ({ fetch: (resource: string, init: RequestInit) => signer.fetch(new Request(resource, init)) }) } } as unknown as Env;
  return { env, db, restart() { signer = new RdpAuthorityDO(state); } };
};
const request = (code: string, site = url, headers = {}) => new Request(site, { headers: { Authorization: `Bearer ${code}`, ...headers } });
const e3 = (env: Env, route = '42') => signDeviceScope(env, new Request(url), 'e3', { route, uid: 2, profile, proof: rand, expires: Date.now() + ENROLL_MS });
const d2 = (env: Env, route = '42') => signDeviceScope(env, new Request(url), 'd2', { route, uid: 2, profile, device });

function b64(raw: ArrayBuffer) { return Buffer.from(raw).toString('base64url'); }

describe('deployment-owned RDP authority', () => {
  it('uses no Worker secret, survives reconstruction, isolates deployments and does not initialize on verification', async () => {
    const f = fixture(), other = fixture();
    const token = await e3(f.env);
    expect(f.db.size).toBe(1);
    f.restart();
    expect(await verifyDeviceScope(f.env, request(token), 'e3')).toMatchObject({ profile, uid: 2, proof: rand });
    expect(await verifyDeviceScope(other.env, request(token), 'e3')).toBeNull();
    expect(other.db.size).toBe(0);
    await e3(other.env);
    expect(await verifyDeviceScope(other.env, request(token), 'e3')).toBeNull();
  });
  it('rejects scope tampering, origin aliases, replay past expiry, browser headers and revoked GitHub identities', async () => {
    vi.useFakeTimers();
    try {
      const { env } = fixture();
      const token = await e3(env);
      for (const req of [request(token.replace('.42.', '.43.')), request(token.replace('.2.', '.3.')), request(token, url.replace('desk.', 'alias.')),
        request(token, url, { Origin: 'https://desk.example' }), request(token, url, { Cookie: 'session=x' })]) expect(await verifyDeviceScope(env, req, 'e3')).toBeNull();
      expect(await verifyDeviceScope({ ...env, GITHUB_ALLOWED_USER_IDS: '41' }, request(token), 'e3')).toBeNull();
      vi.advanceTimersByTime(ENROLL_MS + 1);
      expect(await verifyDeviceScope(env, request(token), 'e3')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('invalidates pending enrollments but not approved device routing on password rotation; requires native Access', async () => {
    const { env } = fixture({ ADMIN_PASSWORD_HASH: 'epoch-A' });
    const rotated = { ...env, ADMIN_PASSWORD_HASH: 'epoch-B' };
    expect(await verifyDeviceScope(rotated, request(await e3(env, '-1')), 'e3')).toBeNull();
    expect(await verifyDeviceScope(rotated, request(await d2(env, '-1')), 'd2')).toMatchObject({ device });
    const cf = fixture({ CF_ACCESS: 'true' }).env;
    const req = request(await d2(cf, `cf-${'e'.repeat(32)}`), url.replace('/register', '/challenge'), { 'CF-Access-Authenticated-User-Email': 'fake@example.com' });
    expect(await verifyDeviceScope(cf, req, 'd2')).toBeNull();
    const identity = vi.fn();
    await initializeAccessIdentity(req, { access: { aud: 'native', getIdentity: identity } });
    expect(await verifyDeviceScope(cf, req, 'd2')).toMatchObject({ device });
    expect(identity).not.toHaveBeenCalled();
  });
  it('refuses a valid legacy manual-confirmation grant instead of automatically approving it', async () => {
    const f = fixture();
    const signed = await e3(f.env);
    const old = signed.split('.').slice(0, -1).join('.').replace(/^e3\./, 'e2.');
    const key = await crypto.subtle.importKey('raw', f.db.get('rdp-signing-key-v2')!, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`cloudssh-rdp-capability-v2\nhttps://desk.example\ngithub\n\n${old}`));
    const candidate = request(`${old}.${Buffer.from(mac).toString('hex')}`);
    expect(await verifyDeviceScope(f.env, candidate, 'e3')).toBeNull();
  });
  it('checks Ed25519 proof of possession with distinct registration and standby audiences', async () => {
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const pub = b64(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer);
    const reg = registrationMessage('enrollment', pub, 'WINDOWS');
    const sig = b64(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(reg)));
    expect(await verifyDeviceSignature(pub, sig, reg)).toBe(true);
    expect(await verifyDeviceSignature(pub, sig, standbyMessage('enrollment', rand))).toBe(false);
  });
  it('does not look up account shards for machine requests without proof and removes the experimental endpoint', async () => {
    const lookedUp = vi.fn();
    const { env } = fixture();
    env.USER_DB = { idFromName: lookedUp } as unknown as DurableObjectNamespace;
    const assets: RdpAssets = { page: '', bootstrap: '', socket: '', peer: '', freerdp: '', wasm: new ArrayBuffer(0), license: '', tags: [] };
    const token = await e3(env);
    const req = new Request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ key: 'invalid', label: 'WINDOWS', signature: 'x' }) });
    expect((await handleRdp(req, new URL(req.url), env, assets)).status).toBe(401);
    const old = request('p1.removed', 'https://desk.example/api/rdp/peer/agent', { Upgrade: 'websocket' });
    expect((await handleRdp(old, new URL(old.url), env, assets)).ok).toBe(false);
    expect(lookedUp).not.toHaveBeenCalled();
  });
});
