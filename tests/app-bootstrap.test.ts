import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_BOOTSTRAP_TIMEOUT_MS,
  loadInitialAppState,
} from '../frontend/src/app-bootstrap';

const config = {
  turnstileEnabled: false,
  githubAuthEnabled: true,
  githubAuthRequired: true,
  authMode: 'github',
};
const user = { id: 1, github_id: -1, username: 'admin', avatar_url: null };
const json = (value: unknown, status = 200) => Response.json(value, { status });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('initial app state', () => {
  it('starts configuration and identity reads together and waits for both', async () => {
    const me = deferred<Response>();
    const fetchMock = vi.fn((path: string) =>
      path === '/api/config' ? Promise.resolve(json(config)) : me.promise
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = loadInitialAppState();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/config', '/api/auth/me']);
    let completed = false;
    void pending.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    me.resolve(json(user));
    await expect(pending).resolves.toEqual({ config, user });
    expect(fetchMock).toHaveBeenCalledWith('/api/config', expect.objectContaining({
      cache: 'no-store', credentials: 'same-origin', signal: expect.any(AbortSignal),
    }));
  });

  it('only a 401 means unauthenticated, preserving the known runtime policy', async () => {
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(
      path === '/api/config' ? json(config) : json({ error: 'Unauthorized' }, 401)
    )));
    await expect(loadInitialAppState()).resolves.toEqual({ config, user: null });
  });

  it.each([403, 429, 500, 503])('rejects auth HTTP %i instead of an anonymous session', async status => {
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(
      path === '/api/config' ? json(config) : json({ error: 'unavailable' }, status)
    )));
    await expect(loadInitialAppState()).rejects.toThrow('Authentication unavailable');
  });

  it.each([
    {},
    { ...config, githubAuthRequired: 'true' },
    { ...config, authMode: 'unknown' },
    { ...config, turnstileEnabled: true, sitekey: undefined },
  ])('rejects incomplete or invalid configuration instead of choosing a form', async value => {
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(
      path === '/api/config' ? json(value) : json(user)
    )));
    await expect(loadInitialAppState()).rejects.toThrow('Invalid configuration');
  });

  it('rejects invalid identity JSON', async () => {
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(
      path === '/api/config' ? json(config) : json({ username: 'admin' })
    )));
    await expect(loadInitialAppState()).rejects.toThrow('Invalid authentication response');
  });

  it('cancels the sibling read on config failure and clears its deadline', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((path: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      if (path === '/api/config') return Promise.resolve(json({}, 500));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }));
    await expect(loadInitialAppState()).rejects.toThrow('Configuration unavailable');
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled requests and retries without cached auth policy', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_path: string, options: RequestInit) => {
      const signal = options.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = expect(loadInitialAppState()).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(APP_BOOTSTRAP_TIMEOUT_MS);
    await pending;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    fetchMock.mockImplementation((path: string) => Promise.resolve(
      path === '/api/config' ? json({ ...config, githubAuthRequired: false }) : json(user)
    ));
    await expect(loadInitialAppState()).resolves.toEqual({
      config: { ...config, githubAuthRequired: false }, user,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active while reading the response body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((path: string, options: RequestInit) => {
      if (path === '/api/auth/me') return Promise.resolve(json(user));
      return Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        }),
      });
    }));
    const pending = expect(loadInitialAppState()).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(APP_BOOTSTRAP_TIMEOUT_MS);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
