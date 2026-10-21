import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAICapabilityHandler } from '../../src/worker/ai-capability-route';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('../../src/worker/agent/capability-probe', () => ({ probeNativeCompaction: probe }));
const passed = { verdict: 'supported', reason: 'verified', step: 'continuation', checkedAt: 1 };
const body = { base_url: 'https://provider.test/v1', model: 'model-test', acknowledge_cost: true };
function request(value: unknown = body, origin: string | null = 'https://cloudssh.test', signal?: AbortSignal) {
  return new Request('https://cloudssh.test/api/ai/capabilities/probe', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(origin == null ? {} : { Origin: origin }) }, body: JSON.stringify(value) });
}
function setup() {
  const handler = createAICapabilityHandler();
  const fetch = vi.fn(async (_request: Request) => Response.json({ base_url: body.base_url, api_key: 'SAVED_SECRET' }));
  const stub = { fetch } as never;
  return { handler, stub, fetch };
}
beforeEach(() => { probe.mockReset().mockResolvedValue(passed); });
afterEach(() => vi.useRealTimers());

describe('Explicitly billed capability route boundary', () => {
  it.each([null, 'https://evil.example'])('rejects missing/cross-site Origin before looking up credentials (%s)', async origin => {
    const { handler, stub, fetch } = setup();
    expect((await handler(request(body, origin), 10, 'github-a', stub)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it.each([false, undefined, 'true', 1])('requires literal cost acknowledgement (%s)', async acknowledge_cost => {
    const { handler, stub, fetch } = setup();
    const res = await handler(request({ ...body, acknowledge_cost }), 10, 'github-a', stub);
    expect(res.status).toBe(400); expect(await res.json()).toMatchObject({ code: 'responses_probe_consent' });
    expect(fetch).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it('uses the saved key only for the canonically bound root and never returns it', async () => {
    const { handler, stub, fetch } = setup();
    const res = await handler(request({ ...body, base_url: body.base_url + '/responses' }), 10, 'github-a', stub);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual(passed);
    expect(fetch.mock.calls[0][0].url).toBe('http://internal/internal/ai-config/decrypt?user_id=10');
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ base_url: body.base_url, model: body.model,
      api_key: 'SAVED_SECRET', context_window: 64000, max_output_tokens: 8192 }), expect.any(AbortSignal));
  });

  it('blocks stored-key exfiltration to an edited address before probing', async () => {
    const { handler, stub } = setup();
    const res = await handler(request({ ...body, base_url: 'https://unbound.example/v1' }), 10, 'github-a', stub);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'responses_key_required' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('accepts an explicit replacement key without fetching saved credentials', async () => {
    const { handler, stub, fetch } = setup();
    await handler(request({ ...body, base_url: 'https://new-provider.example/v1', api_key: 'NEW_SECRET' }), 10, 'github-a', stub);
    expect(fetch).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ api_key: 'NEW_SECRET', base_url: 'https://new-provider.example/v1' }), expect.any(AbortSignal));
  });

  it.each([
    { ...body, model: '' }, { ...body, api_key: {} }, { ...body, base_url: 'http://insecure.example' },
    { ...body, max_output_tokens: 99999999 }, { ...body, extra: 'x'.repeat(17000) },
  ])('rejects invalid/oversized input without an outbound probe (%#)', async value => {
    const { handler, stub } = setup();
    expect((await handler(request(value), 10, 'github-a', stub)).status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
  });

  it('isolates cooldowns by authenticated owner, not a per-shard user ID alone', async () => {
    vi.useFakeTimers();
    const { handler, stub } = setup();
    expect((await handler(request(body), 1, 'github-a', stub)).status).toBe(200);
    const busy = await handler(request(body), 1, 'github-a', stub);
    expect(busy.status).toBe(429); expect(busy.headers.get('Retry-After')).toBe('60');
    expect((await handler(request(body), 1, 'github-b', stub)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await handler(request(body), 1, 'github-a', stub)).status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('rejects concurrent duplicate requests even after the cooldown clock has elapsed', async () => {
    vi.useFakeTimers();
    const { handler, stub } = setup();
    probe.mockImplementation(async () => new Promise(() => {}));
    const pending = handler(request(body), 10, 'github-a', stub);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await handler(request(body), 10, 'github-a', stub)).status).toBe(429);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).status).toBe(504);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds credential lookup even if a DO stub ignores cancellation', async () => {
    vi.useFakeTimers();
    const { handler, fetch, stub } = setup();
    fetch.mockImplementation(async () => new Promise(() => {}));
    const pending = handler(request(body), 10, 'github-a', stub);
    await vi.advanceTimersByTimeAsync(65_000);
    expect((await pending).status).toBe(504);
    expect(probe).not.toHaveBeenCalled();
  });
});
