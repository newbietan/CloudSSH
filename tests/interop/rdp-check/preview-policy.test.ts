import { describe, expect, it } from 'vitest';
import { isPreviewRoute, previewDocumentHeaders, readPreviewConfig } from './preview-policy';

const now = 123000;
const base = {
  expiresAt: now + 1000, publicIp: '93.184.215.14', publicPort: '3389',
  tunnelHost: 'rdp.example.com', certificate: '2'.repeat(64),
};

describe('deployed RDP preview gate', () => {
  it('requires no account configuration and ignores the former owner field', () => {
    const config = readPreviewConfig(JSON.stringify(base), now);
    expect(config?.targets.RDP_CHECK_ENABLE_DESKTOP).toBe('1');
    expect(readPreviewConfig(JSON.stringify({ ...base, owner: '83105156' }), now)).toEqual(config);
    expect(config).not.toHaveProperty('owner');
  });

  it('closes outside the explicit test window and rejects nonpublic or malformed targets', () => {
    for (const update of [{ expiresAt: now }, { expiresAt: now + 90_000_000 }, { publicIp: '127.0.0.1' }, { tunnelHost: 'rdp.example.com/path' }, { certificate: 'invalid' }]) {
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
