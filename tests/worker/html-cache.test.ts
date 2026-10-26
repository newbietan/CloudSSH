import { describe, expect, it } from 'vitest';
import {
  createHtmlResponse,
  getHtmlEtag,
  getHtmlLastModified,
  matchesEtag,
  matchesLastModified,
} from '../../src/worker/html-cache';
import worker from '../../src/worker/index';

describe('HTML ETag & 304 conditional caching', () => {
  it('generates a stable, quoted ETag containing version', () => {
    const etag1 = getHtmlEtag();
    const etag2 = getHtmlEtag();
    expect(etag1).toBe(etag2);
    expect(etag1.startsWith('W/"')).toBe(true);
    expect(etag1.endsWith('"')).toBe(true);
    expect(etag1.length).toBeGreaterThan(10);
  });

  describe('matchesEtag', () => {
    const etag = 'W/"2.8.3-abc-123"';

    it('returns false for null or empty header', () => {
      expect(matchesEtag(null, etag)).toBe(false);
      expect(matchesEtag('', etag)).toBe(false);
    });

    it('matches exact ETag', () => {
      expect(matchesEtag('W/"2.8.3-abc-123"', etag)).toBe(true);
      expect(matchesEtag('"2.8.3-abc-123"', etag)).toBe(true);
    });

    it('matches weak ETag prefix (W/) in If-None-Match', () => {
      expect(matchesEtag('W/"2.8.3-abc-123"', etag)).toBe(true);
    });

    it('matches wildcard (*)', () => {
      expect(matchesEtag('*', etag)).toBe(true);
      expect(matchesEtag('  *  ', etag)).toBe(true);
    });

    it('matches among comma-separated ETags', () => {
      expect(matchesEtag('"other-etag", "2.8.3-abc-123", "third"', etag)).toBe(true);
      expect(matchesEtag('"other-etag", W/"2.8.3-abc-123"', etag)).toBe(true);
    });

    it('rejects non-matching ETags', () => {
      expect(matchesEtag('"2.8.3-different"', etag)).toBe(false);
      expect(matchesEtag('"other-1", "other-2"', etag)).toBe(false);
    });
  });

  describe('matchesLastModified', () => {
    const lastModified = 'Mon, 26 Oct 2026 08:00:00 GMT';

    it('returns false for null or empty header', () => {
      expect(matchesLastModified(null, lastModified)).toBe(false);
      expect(matchesLastModified('', lastModified)).toBe(false);
    });

    it('returns true when client date matches or is newer', () => {
      expect(matchesLastModified(lastModified, lastModified)).toBe(true);
      expect(matchesLastModified('Mon, 26 Oct 2026 09:00:00 GMT', lastModified)).toBe(true);
    });

    it('returns false when client date is older or invalid', () => {
      expect(matchesLastModified('Mon, 26 Oct 2026 07:00:00 GMT', lastModified)).toBe(false);
      expect(matchesLastModified('invalid-date', lastModified)).toBe(false);
    });
  });

  describe('createHtmlResponse', () => {
    it('returns 200 with HTML and required cache/security headers on initial request', async () => {
      const request = new Request('https://cloudssh.local/');
      const response = createHtmlResponse(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html;charset=UTF-8');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
      expect(response.headers.get('ETag')).toBe(getHtmlEtag());
      expect(response.headers.get('Last-Modified')).toBe(getHtmlLastModified());
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');

      const body = await response.text();
      expect(body).toContain('<!doctype html>');
    });

    it('returns 304 Not Modified with empty body when If-None-Match matches', async () => {
      const etag = getHtmlEtag();
      const request = new Request('https://cloudssh.local/', {
        headers: { 'If-None-Match': etag },
      });
      const response = createHtmlResponse(request);

      expect(response.status).toBe(304);
      expect(response.headers.get('ETag')).toBe(etag);
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
      expect(response.headers.get('Last-Modified')).toBe(getHtmlLastModified());
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');

      const body = await response.text();
      expect(body).toBe('');
    });

    it('returns 304 Not Modified when If-Modified-Since is matching or newer', async () => {
      const lastModified = getHtmlLastModified();
      const request = new Request('https://cloudssh.local/', {
        headers: { 'If-Modified-Since': lastModified },
      });
      const response = createHtmlResponse(request);

      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
    });

    it('returns 200 when If-None-Match does not match', async () => {
      const request = new Request('https://cloudssh.local/', {
        headers: { 'If-None-Match': '"stale-etag-999"' },
      });
      const response = createHtmlResponse(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('ETag')).toBe(getHtmlEtag());
      const body = await response.text();
      expect(body).toContain('<!doctype html>');
    });
  });

  describe('Worker integration', () => {
    it('serves HTML via worker.fetch and returns 304 on revalidation', async () => {
      const fakeEnv = {} as any;
      const initialReq = new Request('https://cloudssh.local/');
      const initialRes = await worker.fetch(initialReq, fakeEnv);

      expect(initialRes.status).toBe(200);
      const etag = initialRes.headers.get('ETag');
      expect(etag).toBeTruthy();

      const revalidateReq = new Request('https://cloudssh.local/', {
        headers: { 'If-None-Match': etag! },
      });
      const revalidateRes = await worker.fetch(revalidateReq, fakeEnv);

      expect(revalidateRes.status).toBe(304);
      expect(await revalidateRes.text()).toBe('');
    });
  });
});
