import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { initializeAccessIdentity } from '../../src/worker/auth';
import { makePeerCode, PEER_PAIR_MS, PEER_PROTOCOL, verifyPeerCode } from '../../src/worker/rdp-peer-auth';
import { peerSdp } from '../../src/worker/rdp-peer-rooms';
import { handleRdp, type RdpAssets } from '../../src/worker/rdp-routes';

const id = '12345678-1234-1234-1234-123456789abc';
const url = 'https://cloudssh.example/api/rdp/peer/agent';
const assets: RdpAssets = { page: '', bootstrap: '', socket: '', peer: '', freerdp: '', wasm: new ArrayBuffer(0), license: '', tags: [] };
const env = { RDP_P2P_SECRET: 'ab'.repeat(32), GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' } as Env;
const codeFor = (e: Env, key: string) => makePeerCode(e, new Request(url), key, 2, id, 'c'.repeat(64));
const req = (code: string, u = url) => new Request(u, { headers: { Authorization: `Bearer ${code}`, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_PROTOCOL } });

describe('opt-in RDP peer capabilities', () => {
  it('authenticates full scope, HTTPS origin, mode, allowlist, and a short deadline before shard lookup', async () => {
    vi.useFakeTimers();
    try {
      const code = await codeFor(env, '42');
      expect(await verifyPeerCode(env, req(code))).toMatchObject({ route: '42', uid: 2, id });
      for (const changed of [code.replace('p1.42.', 'p1.43.'), code.replace('.2.', '.3.'), code.replace(id, 'a' + id.slice(1)), code + '0']) {
        expect(await verifyPeerCode(env, req(changed))).toBeNull();
      }
      expect(await verifyPeerCode(env, req(code, url.replace('cloudssh.', 'other.')))).toBeNull();
      expect(await verifyPeerCode({ ...env, GITHUB_ALLOWED_USER_IDS: '41' }, req(code))).toBeNull();
      expect(await verifyPeerCode({ ...env, RDP_P2P_SECRET: 'bad' }, req(code))).toBeNull();
      const admin = { ...env, ADMIN_PASSWORD_HASH: 'generation-1' };
      const a = await codeFor(admin, '-1');
      expect(await verifyPeerCode({ ...admin, ADMIN_PASSWORD_HASH: 'generation-2' }, req(a))).toBeNull();
      expect(await verifyPeerCode(admin, req(code))).toBeNull();
      vi.advanceTimersByTime(PEER_PAIR_MS + 1);
      expect(await verifyPeerCode(env, req(code))).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('requires native Access admission for machine capabilities, never a supplied header or email', async () => {
    const access = { ...env, CF_ACCESS: 'true' };
    const code = await codeFor(access, 'cf-' + 'a'.repeat(32));
    const r = req(code); r.headers.set('CF-Access-Authenticated-User-Email', 'user@example.com');
    expect(await verifyPeerCode(access, r)).toBeNull();
    await initializeAccessIdentity(r, { access: { aud: 'app', getIdentity: async () => { throw new Error(); } } });
    expect(await verifyPeerCode(access, r)).not.toBeNull();
  });
  it('does not let a connector capability access browser APIs or let a browser attach the agent', async () => {
    const lookup = vi.fn(); const e = { ...env, USER_DB: { idFromName: lookup } } as unknown as Env;
    const token = await codeFor(e, '42');
    for (const mutate of [(r: Request) => r.headers.set('Origin', new URL(url).origin), (r: Request) => r.headers.set('Cookie', 'session=x'),
      (r: Request) => r.headers.set('Sec-WebSocket-Protocol', 'wrong'), (r: Request) => r.headers.delete('Authorization')]) {
      const r = req(token); mutate(r); const res = await handleRdp(r, new URL(r.url), e, assets); expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const session = req(token, url.replace('/agent', '/session')); session.headers.set('Origin', new URL(url).origin);
    expect((await handleRdp(session, new URL(session.url), e, assets)).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('only permits bounded data-only SDP (no TURN candidates, media or arbitrary control bytes)', () => {
    const sdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 00:01\r\n';
    expect(peerSdp(sdp)).toBe(true);
    for (const input of [null, new Uint8Array(1), sdp + 'x'.repeat(13000), sdp + '\u0000', sdp + 'm=audio 9 foo\r\n', sdp + 'a=candidate:1 1 udp 1 1.2.3.4 12345 typ relay\r\n']) expect(peerSdp(input)).toBe(false);
  });
});
