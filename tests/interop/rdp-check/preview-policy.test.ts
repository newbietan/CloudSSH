import { describe, expect, it } from 'vitest';
import { isPreviewOwner, isPreviewRoute, previewDocumentHeaders, readPreviewConfig } from './preview-policy';

describe('deployed RDP preview gate', () => {
  it('only allows an exact configured browser account, never the Access sentinel', () => {
    expect(isPreviewOwner('83105156', '83105156')).toBe(true);
    expect(isPreviewOwner('83105156', '1')).toBe(false);
    expect(isPreviewOwner('-1', '-1')).toBe(true);
    const access = 'cf-' + 'a'.repeat(32);
    expect(isPreviewOwner(access, access)).toBe(true);
    expect(isPreviewOwner(access, 'cf-' + 'b'.repeat(32))).toBe(false);
    for (const invalid of [undefined, '', '*', '-2', '01', ' 1', 'cf-access@example.com']) {
      expect(isPreviewOwner(invalid, invalid ?? '')).toBe(false);
    }
  });

  it('closes outside the explicit test window and rejects nonpublic or malformed targets', () => {
    const now = 123000;
    const base = { owner: '-1', expiresAt: now + 1000, publicIp: '93.184.215.14', publicPort: '3389', tunnelHost: 'rdp.example.com', certificate: '2'.repeat(64) };
    expect(readPreviewConfig(JSON.stringify(base), now)?.targets.RDP_CHECK_ENABLE_DESKTOP).toBe('1');
    for (const update of [{ expiresAt: now }, { expiresAt: now + 90_000_000 }, { publicIp: '127.0.0.1' }, { tunnelHost: 'rdp.example.com/path' }, { owner: '*' }, { certificate: 'invalid' }]) {
      expect(readPreviewConfig(JSON.stringify({ ...base, ...update }), now)).toBeNull();
    }
    expect(readPreviewConfig(undefined, now)).toBeNull();
  });

  it('matches only the scoped preview prefix and prevents frames and caching', () => {
    expect(isPreviewRoute('/__rdp-preview')).toBe(true);
    expect(isPreviewRoute('/__rdp-preview/ws/tunnel')).toBe(true);
    for (const path of ['/', '/__rdp-preview-other', '/api/ssh', '/mcp']) {
      expect(isPreviewRoute(path)).toBe(false);
    }
    expect(previewDocumentHeaders['Cache-Control']).toContain('no-store');
    expect(previewDocumentHeaders['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });
});
