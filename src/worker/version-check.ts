import {
  normalizeStableVersion,
  VERSION_CHECK_INTERVAL_MS,
  VERSION_RETRY_INTERVAL_MS,
} from '../version';

// This project publishes by merging test into main, not by creating GitHub Releases.
// Fixed official URL: neither fork metadata nor request parameters can redirect this fetch.
const UPSTREAM_VERSION_URL =
  'https://raw.githubusercontent.com/newbietan/CloudSSH/main/package.json';
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 4000;
interface CachedVersion {
  latestVersion: string | null;
  expiresAt: number;
}
let cached: CachedVersion | null = null;
let pending: Promise<CachedVersion> | null = null;

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(UPSTREAM_VERSION_URL, {
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'CloudSSH-Version-Check' },
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': VERSION_CHECK_INTERVAL_MS / 1000, '300-599': -1 },
      },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || !('version' in data)) return null;
    return normalizeStableVersion(data.version);
  } catch {
    // Optional background check: network/rate-limit/parse errors never affect SSH or auth.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getLatestVersion(): Promise<CachedVersion> {
  if (cached && Date.now() < cached.expiresAt) return cached;
  if (pending) return pending;
  pending = fetchLatestVersion().then((latestVersion) => {
    const ttl = latestVersion ? VERSION_CHECK_INTERVAL_MS : VERSION_RETRY_INTERVAL_MS;
    cached = { latestVersion, expiresAt: Date.now() + ttl };
    pending = null;
    return cached;
  });
  return pending;
}

export async function handleVersionCheck(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  }
  const { latestVersion, expiresAt } = await getLatestVersion();
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return Response.json(
    { latestVersion },
    {
      headers: {
        'Cache-Control': `public, max-age=${maxAge}`,
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}
