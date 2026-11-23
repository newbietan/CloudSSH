import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/types';
import { createPreviewHandler, type PreviewBindings, verifyPreviewSession } from './preview-handler';
import { PREVIEW_PATH } from './preview-policy';

const site = 'https://test-cloudssh.example';
const current = 100000;
const route = PREVIEW_PATH + '/ws/tunnel';
const token = '11'.repeat(32);
const config = {
  expiresAt: current + 1_000, publicIp: '93.184.215.14', publicPort: '3389',
  tunnelHost: 'rdp.example.com', certificate: token,
};
const env = { RDP_PREVIEW_CONFIG: JSON.stringify(config) };
const upgrade = { Origin: site, Upgrade: 'websocket' };

function fixture() {
  let clock = current;
  const isAuthenticated = vi.fn<() => Promise<boolean>>(async () => true);
  const main = vi.fn(async () => new Response('usual application'));
  const open = vi.fn(() => new Response('fake WS'));
  const handler = createPreviewHandler<PreviewBindings, null>({
    main, isAuthenticated, open, now: () => clock,
    files: new Map([['/index.html', ['<html></html>', 'text/html']]]),
  });
  return { isAuthenticated, main, open, handler, tick: () => { clock = config.expiresAt; } };
}

describe('test-only RDP preview request routing', () => {
  it('keeps ordinary traffic with the main Worker even if preview is disabled', async () => {
    const { handler, isAuthenticated, main } = fixture();
    const request = new Request(site + '/api/ssh');
    expect(await (await handler(request, {}, null)).text()).toBe('usual application');
    expect(main).toHaveBeenCalledWith(request, {}, null);
    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  it('rejects arbitrary or cross-origin requests before authentication or dialing', async () => {
    const { handler, isAuthenticated, open } = fixture();
    for (const request of [
      new Request(site + route),
      new Request(site + route, { headers: { ...upgrade, Origin: 'https://rdp.example.com' } }),
      new Request(site + route + '?target=other', { headers: upgrade }),
      new Request(site + route, { method: 'POST', headers: upgrade }),
      new Request(site + PREVIEW_PATH + '/unknown'),
      new Request(site.replace('https:', 'http:') + PREVIEW_PATH + '/'),
    ]) expect((await handler(request, env, null)).status).toBe(404);
    expect((await handler(new Request(site + route, { headers: upgrade }), {}, null)).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated sessions on the page, config, and both relay routes', async () => {
    const { handler, isAuthenticated, open } = fixture();
    isAuthenticated.mockResolvedValue(false);
    for (const path of [PREVIEW_PATH + '/', PREVIEW_PATH + '/config', route, PREVIEW_PATH + '/ws/public']) {
      expect((await handler(new Request(site + path, { headers: upgrade }), env, null)).status).toBe(404);
    }
    isAuthenticated.mockRejectedValueOnce(new Error('private upstream error'));
    const error = await handler(new Request(site + route, { headers: upgrade }), env, null);
    expect(error.status).toBe(404);
    expect(await error.text()).toBe('');
    expect(open).not.toHaveBeenCalled();
  });

  it('lets a verified CloudSSH session open the page and both routes without an owner match', async () => {
    const { handler, open } = fixture();
    const oldBinding = { RDP_PREVIEW_CONFIG: JSON.stringify({ ...config, owner: '83105156' }) };
    expect((await handler(new Request(site + PREVIEW_PATH + '/'), oldBinding, null)).status).toBe(200);
    for (const target of ['public', 'tunnel']) {
      const request = new Request(site + PREVIEW_PATH + '/ws/' + target, { headers: upgrade });
      expect(await (await handler(request, oldBinding, null)).text()).toBe('fake WS');
      expect(open).toHaveBeenLastCalledWith(request, expect.any(Object), target, site, 1_000);
    }
  });

  it('accepts a real password-mode session on the page and relay, but rejects an old generation', async () => {
    const hash = `pbkdf2$sha256$1000$${Buffer.alloc(8, 1).toString('base64url')}$${Buffer.alloc(32, 2).toString('base64url')}`;
    const generation = createHash('sha256').update(hash).digest('hex').slice(0, 8);
    const verify = vi.fn(async () => Response.json({ github_id: -1 }));
    const adminEnv = {
      ...env,
      RDP_PREVIEW_CONFIG: JSON.stringify({ ...config, owner: '83105156' }),
      ADMIN_PASSWORD_HASH: hash,
      USER_DB: { idFromName: (name: string) => name, get: () => ({ fetch: verify }) },
    } as unknown as Env & PreviewBindings;
    const open = vi.fn(() => new Response('fake WS'));
    const handler = createPreviewHandler<Env & PreviewBindings, undefined>({
      main: async () => new Response(null, { status: 404 }),
      isAuthenticated: verifyPreviewSession,
      open,
      now: () => current,
      files: new Map([['/index.html', ['<html></html>', 'text/html']]]),
    });
    const headers = { ...upgrade, Cookie: `session=-1:${generation}:${'1'.repeat(64)}` };
    expect((await handler(new Request(site + PREVIEW_PATH + '/', { headers }), adminEnv, undefined)).status).toBe(200);
    expect((await handler(new Request(site + route, { headers }), adminEnv, undefined)).status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(2);
    const stale = { ...adminEnv, ADMIN_PASSWORD_HASH: hash.replace('$1000$', '$1001$') };
    expect((await handler(new Request(site + route, { headers }), stale, undefined)).status).toBe(404);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledOnce();
  });

  it('only exposes the public certificate pin and dials the configured route', async () => {
    const { handler, open } = fixture();
    const metadata = await handler(new Request(site + PREVIEW_PATH + '/config'), env, null);
    expect(await metadata.json()).toEqual({ fingerprint: token, public: true, tunnel: true });
    expect(metadata.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(metadata.headers.get('Cache-Control')).toBe('private, no-store, no-transform');
    const request = new Request(site + route, { headers: { ...upgrade, 'x-target': 'other' } });
    expect(await (await handler(request, env, null)).text()).toBe('fake WS');
    expect(open).toHaveBeenCalledWith(request, expect.objectContaining({
      RDP_CHECK_PUBLIC_IP: config.publicIp, RDP_CHECK_TUNNEL_HOST: config.tunnelHost,
    }), 'tunnel', site, 1_000);
  });

  it('rechecks expiry after awaiting authentication', async () => {
    const { handler, isAuthenticated, open, tick } = fixture();
    isAuthenticated.mockImplementationOnce(async () => { tick(); return true; });
    expect((await handler(new Request(site + route, { headers: upgrade }), env, null)).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });
});
