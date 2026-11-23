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
  const env = { ENABLE_RDP: 'true', GITHUB_CLIENT_ID: 'mock', GITHUB_CLIENT_SECRET: 'mock',
    USER_DB: { idFromName: (name: string) => name, get: () => ({ fetch: internal }) },
  } as unknown as Env;
  const handle = (path: string, init?: RequestInit, enabled = true) => {
    const url = new URL(path, origin);
    return handleRdp(new Request(url, init), url, env, enabled ? assets : undefined);
  };
  return { handle, internal };
}

describe('formal RDP routing', () => {
  it('returns 404 for the retired preview and its former descendants', async () => {
    for (const path of ['/__rdp-preview', '/__rdp-preview/', '/__rdp-preview/ws/public']) {
      const response = await worker.fetch(new Request(origin + path), {} as Env);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('fails before side effects for disabled deployment, anonymous and cross-origin writes', async () => {
    const { handle, internal } = fixture();
    const path = `/api/rdp/profiles/${id}/connect`;
    expect((await handle(path, { method: 'POST', headers: { Origin: origin } }, false)).status).toBe(404);
    expect((await handle(path, { method: 'POST', headers: { Origin: 'https://other.example' } })).status).toBe(403);
    expect((await handle(path, { method: 'POST' })).status).toBe(403);
    expect((await handle('/rdp/assets/desktop.js')).status).toBe(401);
    expect(internal).not.toHaveBeenCalled();
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
    const response = await handle(`/api/rdp/profiles/${id}/connect`, { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-cloudssh_rdp=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    const [request] = internal.mock.calls.at(-1)!;
    expect(request.url).toBe('https://internal/internal/rdp/ticket?user_id=5');
    expect(await request.json()).toEqual({ profile: id, binding: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(response.headers.get('Location')).toBeNull();
    const desktop = await handle(`/rdp/${id}`, { headers });
    expect(desktop.headers.get('X-Frame-Options')).toBe('DENY');
    const embedded = await handle(`/rdp/${id}/client`, { headers });
    expect(await embedded.text()).toBe('desktop page');
    expect(embedded.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
    expect(desktop.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });
});
