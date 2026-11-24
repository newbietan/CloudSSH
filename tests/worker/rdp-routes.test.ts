import { describe, expect, it, vi } from 'vitest';
import { RDP_CLIENT_REVISION } from '../../src/rdp-schema';
import worker from '../../src/worker/index';
import { handleRdp, type RdpAssets } from '../../src/worker/rdp-routes';
import type { Env } from '../../src/types';

const origin = 'https://cloudssh.example';
const id = '12345678-1234-1234-1234-123456789abc';
const assets: RdpAssets = { page: 'desktop page', bootstrap: '', socket: '', freerdp: '', wasm: new ArrayBuffer(0), license: '', tags: [] };
function fixture() {
  const internal = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/internal/session/verify') return Response.json({ id: 5, github_id: 42 });
    if (path === '/internal/rdp/ticket') return Response.json({ ticket: '1'.repeat(64), revision: 1 });
    if (path === `/internal/rdp/profiles/${id}`) return Response.json({ id });
    if (path === `/internal/rdp/profiles/${id}/trust`) return Response.json({ fingerprint: 'a'.repeat(64) });
    return new Response(null, { status: 404 });
  });
  const env = { GITHUB_CLIENT_ID: 'mock', GITHUB_CLIENT_SECRET: 'mock',
    USER_DB: { idFromName: (name: string) => name, get: () => ({ fetch: internal }) },
  } as unknown as Env;
  const handle = (path: string, init?: RequestInit, withAssets = true) => {
    const url = new URL(path, origin);
    return handleRdp(new Request(url, init), url, env, withAssets ? assets : undefined);
  };
  return { handle, internal, env };
}

describe('formal RDP routing', () => {
  it('returns 404 for the retired preview and its former descendants', async () => {
    for (const path of ['/__rdp-preview', '/__rdp-preview/', '/__rdp-preview/ws/public']) {
      const response = await worker.fetch(new Request(origin + path), {} as Env);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('advertises built-in RDP only with client assets over HTTPS', async () => {
    const { env } = fixture();
    const config = async (url: string, client?: RdpAssets) =>
      (await worker.fetch(new Request(url + '/api/config'), env, undefined, client)).json();
    expect(await config(origin, assets)).toHaveProperty('rdpEnabled', true);
    expect(await config(origin)).not.toHaveProperty('rdpEnabled');
    expect(await config('http://cloudssh.example', assets)).not.toHaveProperty('rdpEnabled');
  });

  it('rejects missing assets, HTTP, anonymous access and cross-origin writes before side effects', async () => {
    const { handle, internal } = fixture();
    const path = `/api/rdp/profiles/${id}/connect`;
    expect((await handle(path, { method: 'POST', headers: { Origin: origin } }, false)).status).toBe(404);
    expect((await handle(path, { method: 'POST', headers: { Origin: 'https://other.example' } })).status).toBe(403);
    expect((await handle(path, { method: 'POST' })).status).toBe(403);
    expect((await handle('http://cloudssh.example/rdp/assets/desktop.js')).status).toBe(404);
    expect((await handle('/rdp/assets/desktop.js')).status).toBe(401);
    expect(internal).not.toHaveBeenCalled();
  });

  it('isolates only a verified RDP account home, with private validators distinct from login', async () => {
    const { env, internal } = fixture();
    const page = (path: string, headers?: Record<string, string>, withAssets = true) => worker.fetch(new Request(origin + path, { headers }), env, undefined, withAssets ? assets : undefined);
    const cookie = { Cookie: 'session=42:cookie-value' };
    const login = await page('/');
    const home = await page('/?lang=zh-CN', { ...cookie, 'If-None-Match': login.headers.get('ETag')! });
    expect(home.status).toBe(200);
    expect(home.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(home.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(home.headers.get('Cache-Control')).toContain('private');
    expect(home.headers.get('Vary')).toContain('Cookie');
    const etag = home.headers.get('ETag')!;
    expect(etag).not.toBe(login.headers.get('ETag'));
    const cached = await page('/', { ...cookie, 'If-None-Match': etag });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    for (const plain of [login, await page('/', { 'If-None-Match': etag }), await page('/?signin', cookie),
      await page('/?wsUrl=ignored', cookie), await page('/', cookie, false)]) {
      expect(plain.status).toBe(200);
      expect(plain.headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    }
    internal.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await page('/', cookie)).headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    expect((await page('/', { ...cookie, 'If-None-Match': '*' })).status).toBe(200);
  });

  it('isolates the signed-in admin home but not an expired password generation', async () => {
    const { env, internal } = fixture();
    const hash = 'pbkdf2$sha256$1000$MTIzNDU2Nzg$' + 'A'.repeat(43);
    env.ADMIN_PASSWORD_HASH = hash;
    const generation = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hash))).toString('hex').slice(0, 8);
    internal.mockResolvedValue(Response.json({ id: 1, username: 'admin', github_id: -1 }));
    const home = (gen: string) => worker.fetch(new Request(origin, { headers: { Cookie: `session=-1:${gen}:synthetic` } }), env, undefined, assets);
    expect((await home(generation)).headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect((await home('expired')).headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
  });

  it('only forwards trust from an authenticated same-origin client with the current ABI', async () => {
    const { handle, internal } = fixture();
    const path = `/api/rdp/profiles/${id}/trust`;
    const headers = { Origin: origin, Cookie: 'session=42:cookie-value', 'X-CloudSSH-RDP-Client': '1' };
    const payload = { fingerprint: 'a'.repeat(64), lease: id, revision: 1 };
    expect((await handle(path, { method: 'PUT', headers })).status).toBe(409);
    headers['X-CloudSSH-RDP-Client'] = String(RDP_CLIENT_REVISION);
    expect((await handle(path, { method: 'PUT', headers: { ...headers, Origin: 'https://other.example' } })).status).toBe(403);
    expect((await handle(path, { method: 'PUT', headers, body: JSON.stringify(payload) })).status).toBe(200);
    const [request] = internal.mock.calls.at(-1)!;
    expect(request.url).toBe(`https://internal/internal/rdp/profiles/${id}/trust?user_id=5`);
    expect(await request.json()).toEqual(payload);
  });

  it('binds a connection ticket to the current account and a secure browser cookie', async () => {
    const { handle, internal } = fixture();
    const headers = { Origin: origin, Cookie: 'session=42:cookie-value', 'X-CloudSSH-RDP-Client': String(RDP_CLIENT_REVISION) };
    const stale = await handle(`/api/rdp/profiles/${id}/connect`, { method: 'POST', headers: { ...headers, 'X-CloudSSH-RDP-Client': '0' } });
    expect(stale.status).toBe(409);
    expect((await handle(`/api/rdp/profiles/${id}/connect`, { method: 'POST', headers })).status).toBe(400);
    const response = await handle(`/api/rdp/profiles/${id}/connect`, { method: 'POST', headers: { ...headers, 'X-CloudSSH-RDP-Saved-Revision': '1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-cloudssh_rdp=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    const [request] = internal.mock.calls.at(-1)!;
    expect(request.url).toBe('https://internal/internal/rdp/ticket?user_id=5');
    expect(await request.json()).toEqual({ profile: id, savedRevision: 1, binding: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(response.headers.get('Location')).toBeNull();
    const desktop = await handle(`/rdp/${id}`, { headers });
    expect(desktop.headers.get('X-Frame-Options')).toBe('DENY');
    const embedded = await handle(`/rdp/${id}/client`, { headers });
    expect(await embedded.text()).toBe('desktop page');
    expect(embedded.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
    expect(desktop.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });
});
