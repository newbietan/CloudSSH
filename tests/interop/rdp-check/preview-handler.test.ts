import { describe, expect, it, vi } from 'vitest';
import { createPreviewHandler, type PreviewBindings } from './preview-handler';
import { PREVIEW_PATH } from './preview-policy';

const site = 'https://test-cloudssh.example';
const current = 100000;
const route = PREVIEW_PATH + '/ws/tunnel';
const token = '11'.repeat(32);
const config = {
  owner: '11', expiresAt: current + 1_000, publicIp: '93.184.215.14', publicPort: '3389',
  tunnelHost: 'rdp.example.com', certificate: token,
};
const env = { RDP_PREVIEW_CONFIG: JSON.stringify(config) };
const upgrade = { Origin: site, Upgrade: 'websocket' };

function fixture() {
  let clock = current;
  const getOwner = vi.fn<() => Promise<string | null>>(async () => '11');
  const main = vi.fn(async () => new Response('usual application'));
  const open = vi.fn(() => new Response('fake WS'));
  const handler = createPreviewHandler<PreviewBindings, null>({
    main, getOwner, open, now: () => clock,
    files: new Map([['/index.html', ['<html></html>', 'text/html']]]),
  });
  return { getOwner, main, open, handler, tick: () => { clock = config.expiresAt; } };
}

describe('test-only RDP preview request routing', () => {
  it('keeps ordinary traffic with the main Worker even if preview is disabled', async () => {
    const { handler, getOwner, main } = fixture();
    const request = new Request(site + '/api/ssh');
    expect(await (await handler(request, {}, null)).text()).toBe('usual application');
    expect(main).toHaveBeenCalledWith(request, {}, null);
    expect(getOwner).not.toHaveBeenCalled();
  });

  it('rejects arbitrary or cross-origin requests before authentication or dialing', async () => {
    const { handler, getOwner, open } = fixture();
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
    expect(getOwner).not.toHaveBeenCalled();
  });

  it('restricts files, config and both relay routes to the exact owner', async () => {
    const { handler, getOwner, open } = fixture();
    for (const unauthorized of [null, '12', '-2']) {
      getOwner.mockResolvedValue(unauthorized);
      for (const path of [PREVIEW_PATH + '/', PREVIEW_PATH + '/config', route, PREVIEW_PATH + '/ws/public']) {
        expect((await handler(new Request(site + path, { headers: upgrade }), env, null)).status).toBe(404);
      }
    }
    getOwner.mockRejectedValueOnce(new Error('private upstream error'));
    const error = await handler(new Request(site + route, { headers: upgrade }), env, null);
    expect(error.status).toBe(404);
    expect(await error.text()).toBe('');
    expect(open).not.toHaveBeenCalled();
  });

  it('only exposes the public certificate pin and dials the configured route', async () => {
    const { handler, open } = fixture();
    const metadata = await handler(new Request(site + PREVIEW_PATH + '/config'), env, null);
    expect(await metadata.json()).toEqual({ fingerprint: token, public: true, tunnel: true });
    expect(metadata.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(metadata.headers.get('Cache-Control')).toBe('private, no-store');
    const request = new Request(site + route, { headers: { ...upgrade, 'x-target': 'other' } });
    expect(await (await handler(request, env, null)).text()).toBe('fake WS');
    expect(open).toHaveBeenCalledWith(request, expect.objectContaining({
      RDP_CHECK_PUBLIC_IP: config.publicIp, RDP_CHECK_TUNNEL_HOST: config.tunnelHost,
    }), 'tunnel', site, 1_000);
  });

  it('rechecks expiry after awaiting authentication', async () => {
    const { handler, getOwner, open, tick } = fixture();
    getOwner.mockImplementationOnce(async () => { tick(); return config.owner; });
    expect((await handler(new Request(site + route, { headers: upgrade }), env, null)).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });
});
