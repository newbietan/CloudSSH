import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/types';
import { createAgentMemoryProvider } from '../../../src/worker/agent/memory-provider';

function setup(response: Response | (() => Promise<Response>)) {
  const fetch = vi.fn(async (_request: Request) => typeof response === 'function' ? await response() : response);
  const env = { USER_DB: { idFromName: vi.fn(value => value), get: vi.fn(() => ({ fetch })) } } as unknown as Env;
  const provider = createAgentMemoryProvider(env, 'github-id', '10', 1);
  return { provider, fetch };
}
const batch = { expectedRevision: 7, sessionId: 'session', epoch: 0, knowledge: [] };
afterEach(() => vi.useRealTimers());

describe('Authoritative memory storage adapter', () => {
  it.each([400, 403, 404, 500])('does not swallow failed write HTTP %s or expose its body', async status => {
    const { provider } = setup(new Response('SECRET_STORAGE_BODY', { status }));
    const error = await provider.saveBatchMemory(batch).catch(error => error);
    expect(error).toMatchObject({ code: 'responses_memory_storage', status });
    expect(JSON.stringify(error)).not.toContain('SECRET');
  });

  it.each([true, false])('distinguishes revision conflicts from stale sessions (revision=%s)', async revision => {
    const { provider } = setup(Response.json({ code: revision ? 'memory_revision_conflict' : 'stale_session', error: 'SECRET' }, { status: 409 }));
    await expect(provider.saveBatchMemory(batch)).rejects.toMatchObject({ code: revision ? 'responses_memory_conflict' : 'responses_memory_storage', status: 409 });
  });

  it('does not turn a failed read into an empty revision-zero memory', async () => {
    const { provider } = setup(new Response('', { status: 500 }));
    await expect(provider.fetchUnifiedMemory()).rejects.toMatchObject({ code: 'responses_memory_storage' });
  });

  it('binds writes to server/user and keeps them on internal DO routes', async () => {
    const { provider, fetch } = setup(Response.json({ success: true }));
    await provider.saveBatchMemory(batch);
    const req = fetch.mock.calls[0][0] as Request;
    expect(req.url).toBe('http://internal/internal/servers/1/memory/batch');
    expect(await req.json()).toEqual({ user_id: 10, ...batch });
  });

  it('bounds non-cancellable DO calls with an independent 10s deadline', async () => {
    vi.useFakeTimers();
    const { provider } = setup(async () => new Promise(() => {}));
    const pending = provider.fetchUnifiedMemory();
    const checked = expect(pending).rejects.toMatchObject({ code: 'responses_memory_storage' });
    await vi.advanceTimersByTimeAsync(10_000);
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors reset/parent cancellation without retrying a write', async () => {
    const { provider, fetch } = setup(async () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = provider.saveBatchMemory(batch, controller.signal);
    controller.abort('reset');
    await expect(pending).rejects.toMatchObject({ code: 'responses_memory_storage' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
