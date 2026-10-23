import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { VERSION_CHECK_INTERVAL_MS, VERSION_RETRY_INTERVAL_MS } from '../../src/version';

const upstream = 'https://raw.githubusercontent.com/newbietan/CloudSSH/main/package.json';
const fetchMock = vi.fn<typeof fetch>();
const request = () => new Request('https://cloudssh.example/api/version');

async function loadHandler() {
  return (await import('../../src/worker/version-check')).handleVersionCheck;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('public update check', () => {
  it('routes publicly, fetches only fixed upstream metadata and forwards no credentials', async () => {
    fetchMock.mockResolvedValue(Response.json({ version: 'v2.10.0+build.4', scripts: 'ignored' }));
    const worker = (await import('../../src/worker/index')).default;
    const response = await worker.fetch(new Request(
      'https://cloudssh.example/api/version?url=http://127.0.0.1/private',
      { headers: { Cookie: 'session=secret', Authorization: 'Bearer secret' } }
    ), { REQUIRE_GITHUB_AUTH: 'true' } as Env);
    expect(await response.json()).toEqual({ latestVersion: '2.10.0' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(upstream);
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('public, max-age=21600');
  });

  it('uses a Workers-compatible redirect mode so valid metadata is not silently lost', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      // Node fetch supports 'error', but Workers only accepts 'follow' and 'manual'.
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
      return Response.json({ version: '2.8.2' });
    });
    const handle = await loadHandler();
    expect(await (await handle(request())).json()).toEqual({ latestVersion: '2.8.2' });
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it.each([301, 302, 303, 307, 308])('rejects an upstream %i without following its target', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, {
      status, headers: { Location: 'http://127.0.0.1/private' },
    }));
    const response = await (await loadHandler())(request());
    expect(await response.json()).toEqual({ latestVersion: null });
    expect(response.headers.get('cache-control')).toBe('public, max-age=900');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(upstream, expect.objectContaining({
      redirect: 'manual',
    }));
  });

  it('deduplicates concurrent requests and refreshes expired success caches', async () => {
    fetchMock.mockImplementation(async () => Response.json({ version: '2.8.0' }));
    const handle = await loadHandler();
    const results = await Promise.all(Array.from({ length: 5 }, () => handle(request())));
    expect(await results[4].json()).toEqual({ latestVersion: '2.8.0' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_INTERVAL_MS - 1);
    await handle(request());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    fetchMock.mockImplementation(async () => Response.json({ version: '2.8.1' }));
    expect(await (await handle(request())).json()).toEqual({ latestVersion: '2.8.1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('silently backs off failures and retries after 15 minutes', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const handle = await loadHandler();
    const response = await handle(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ latestVersion: null });
    expect(response.headers.get('cache-control')).toBe('public, max-age=900');
    await handle(request());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(VERSION_RETRY_INTERVAL_MS);
    fetchMock.mockResolvedValue(Response.json({ version: '2.9.0' }));
    expect(await (await handle(request())).json()).toEqual({ latestVersion: '2.9.0' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => new Response('rate limited', { status: 429 }),
    () => new Response('<html>not JSON</html>'),
    () => Response.json(null),
    () => Response.json({}),
    () => Response.json({ version: '3.0.0-beta.1' }),
    () => Response.json({ version: 'javascript:alert(1)' }),
    () => Response.json({ version: 42 }),
    () => new Response(' '.repeat(16 * 1024 + 1)),
  ])('ignores failed, oversized or invalid upstream responses %#', async (makeResponse) => {
    fetchMock.mockResolvedValue(makeResponse());
    expect(await (await (await loadHandler())(request())).json()).toEqual({ latestVersion: null });
  });

  it('aborts a slow fetch at four seconds', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const result = (await loadHandler())(request());
    await vi.advanceTimersByTimeAsync(4000);
    expect(await (await result).json()).toEqual({ latestVersion: null });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds response-body reads by the same deadline', async () => {
    fetchMock.mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
    })));
    const result = (await loadHandler())(request());
    await vi.advanceTimersByTimeAsync(4000);
    expect(await (await result).json()).toEqual({ latestVersion: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects non-GET methods without an upstream request', async () => {
    const handle = await loadHandler();
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const response = await handle(new Request(request(), { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
