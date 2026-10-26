import { APP_VERSION } from '../version';
import { HTML } from './html';

let cachedHtmlEtag: string | null = null;
let cachedLastModified: string | null = null;

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
 * Returns a stable Last-Modified HTTP Date based deterministically on version and HTML content.
 * Acts as an RFC standard fallback validator when edge proxies transform HTML or strip ETags.
 */
export function getHtmlLastModified(): string {
  if (!cachedLastModified) {
    let h = 0x811c9dc5;
    const len = HTML.length;
    for (let i = 0; i < len; i++) {
      h = Math.imul(h ^ HTML.charCodeAt(i), 0x01000193);
    }
    const epochSec = 1767225600 + (Math.abs(h) % 31536000);
    cachedLastModified = new Date(epochSec * 1000).toUTCString();
  }
  return cachedLastModified;
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
 * Checks whether the incoming If-Modified-Since header matches or is newer than Last-Modified.
 */
export function matchesLastModified(ifModifiedSince: string | null, lastModified: string): boolean {
  if (!ifModifiedSince) return false;
  const ims = Date.parse(ifModifiedSince);
  const lm = Date.parse(lastModified);
  return !Number.isNaN(ims) && !Number.isNaN(lm) && ims >= lm;
}

/**
 * Builds the HTML response with ETag, Last-Modified and 304 Not Modified conditional caching.
 * Uses `Cache-Control: no-cache, no-transform` so browsers always revalidate with the Worker
 * and edge proxies (e.g. Cloudflare) preserve ETag/caching validators without stripping them.
 */
export function createHtmlResponse(request: Request): Response {
  const etag = getHtmlEtag();
  const lastModified = getHtmlLastModified();
  const ifNoneMatch = request.headers.get('If-None-Match');
  const ifModifiedSince = request.headers.get('If-Modified-Since');

  const baseHeaders = {
    ETag: etag,
    'Last-Modified': lastModified,
    'Cache-Control': 'no-cache, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };

  const isEtagMatch = matchesEtag(ifNoneMatch, etag);
  const isDateMatch = matchesLastModified(ifModifiedSince, lastModified);

  if (ifNoneMatch ? isEtagMatch : isDateMatch) {
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
