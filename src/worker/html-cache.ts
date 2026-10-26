import { APP_VERSION } from '../version';
import { HTML } from './html';

let cachedHtmlEtag: string | null = null;

/**
 * Returns a stable, deterministic ETag based on the current build version and inlined HTML payload.
 * Cached in-memory per isolate for zero-overhead repeat lookups.
 */
export function getHtmlEtag(): string {
  if (!cachedHtmlEtag) {
    let h1 = 0x811c9dc5;
    let h2 = 0x27d4eb2f;
    const len = HTML.length;
    for (let i = 0; i < len; i++) {
      const c = HTML.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ (c >>> 8), 0x01000193);
    }
    cachedHtmlEtag = `W/"${APP_VERSION}-${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}"`;
  }
  return cachedHtmlEtag;
}

/**
 * Checks whether the incoming If-None-Match header matches the expected ETag.
 * Supports exact match, weak ETags (W/ prefix), comma-separated lists, and wildcard (*).
 */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') return true;
  const target = etag.replace(/^W\//, '');
  return trimmed
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .includes(target);
}

/**
 * Builds the HTML response with ETag and 304 Not Modified conditional caching.
 * Uses `Cache-Control: no-cache` so browsers always revalidate with the Worker,
 * preventing stale frontend code across deployments while saving 2MB+ on repeat visits.
 */
export function createHtmlResponse(request: Request): Response {
  const etag = getHtmlEtag();
  const ifNoneMatch = request.headers.get('If-None-Match');

  const baseHeaders = {
    ETag: etag,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };

  if (matchesEtag(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: baseHeaders,
    });
  }

  return new Response(HTML, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Type': 'text/html;charset=UTF-8',
    },
  });
}
