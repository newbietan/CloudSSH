import { describe, expect, it, vi } from 'vitest';
import { RDP_CONNECTOR_DOWNLOAD, RDP_CONNECTOR_MAX_DOWNLOAD } from '../../src/rdp-schema';
import { downloadRdpConnector } from '../../src/worker/rdp-connector-download';

const asset = 'https://release-assets.githubusercontent.com/github-production-release-asset/1000/abcd-1234?signature=fixture';
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });
const zip = (length = 4096, actual = length) => new Response(new Uint8Array(actual), { headers: {
  'Content-Length': String(length), 'Content-Type': 'application/octet-stream', 'Set-Cookie': 'ignore=cookie',
} });

describe('authenticated page download streams only the fixed Windows package', () => {
  it('uses a fixed GitHub release and one allowlisted HTTPS redirect, with no requester credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(redirect(asset)).mockResolvedValueOnce(zip());
    const res = await downloadRdpConnector(undefined, fetch);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([RDP_CONNECTOR_DOWNLOAD, asset]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe('manual');
      expect([...new Headers(init?.headers).keys()]).toEqual(['accept']);
    }
    expect(res.headers.get('Content-Disposition')).toContain('attachment;');
    expect(res.headers.has('Set-Cookie')).toBe(false);
    expect((await res.arrayBuffer()).byteLength).toBe(4096);
  });
  it.each(['https://example.org/another/release.exe', 'https://release-assets.githubusercontent.com.evil/another/release.exe',
    'https://user@release-assets.githubusercontent.com/another/release', 'http://release-assets.githubusercontent.com/another/release'])(
    'never follows a redirect outside the fixed GitHub asset boundary: %s', async location => {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect(location));
      expect((await downloadRdpConnector(undefined, request)).status).toBe(503);
      expect(request).toHaveBeenCalledOnce();
    });
  it('rejects missing, nested redirects, oversize and partial downloads', async () => {
    for (const bad of [new Response('not found', { status: 404 }), zip(RDP_CONNECTOR_MAX_DOWNLOAD + 1, 1), redirect(asset)]) {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect(asset)).mockResolvedValueOnce(bad);
      expect((await downloadRdpConnector(undefined, request)).status).toBe(503);
    }
    for (const bytes of [2048, 8192]) {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(zip(4096, bytes));
      await expect((await downloadRdpConnector(undefined, request)).arrayBuffer()).rejects.toThrow(/download/);
    }
  });
});
