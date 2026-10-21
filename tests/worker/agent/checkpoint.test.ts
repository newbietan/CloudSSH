import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareContextCheckpoint, CHECKPOINT_DEADLINE_MS } from '../../../src/worker/agent/checkpoint';
import { AgentContext } from '../../../src/worker/agent/context';
import type { OperationFact } from '../../../src/worker/agent/execution-journal';
import { ResponsesClient } from '../../../src/worker/agent/responses-client';
import type { ModelResponse, ResponseInput } from '../../../src/worker/agent/types';
import { aiConfig, compactedWindow, compactReply, compactObject, functionCall } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup(count = 3) {
  const context = new AgentContext();
  context.beginTurn('Inspect nginx; never change firewall rules.');
  const model: ModelResponse = { id: 'accepted', text: 'Inspecting', output: [], calls: [] };
  context.accept(model, context.buildInput());
  const facts: OperationFact[] = Array.from({ length: count }, (_, i) => ({ taskId: 'task', callId: `call_${i}`,
    tool: 'execute_command', description: `inspect_${i}`, status: i === 1 ? 'unknown' : 'succeeded',
    executed: true, exitCode: i === 1 ? -1 : 0, evidence: `observed_${i}`, at: i }));
  const controller = new AbortController();
  const client = new ResponsesClient(aiConfig);
  const options = { context, client, instructions: 'Stable trusted system instructions', facts, signal: controller.signal,
    canContinue: vi.fn((input: ResponseInput[]) => context.fitsBudget(55_808, 'Stable', input)), onUsage: vi.fn() };
  return { context, facts, controller, options };
}

describe('Atomic native Responses compaction', () => {
  it('posts the whole current window with ONLY compact-supported fields', async () => {
    const { context, options } = setup();
    const before = context.buildInput();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(compactReply());
    const result = await prepareContextCheckpoint(options);
    expect(fetch.mock.calls[0][0]).toBe(aiConfig.base_url + '/responses/compact');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: aiConfig.model,
      input: before, instructions: options.instructions });
    expect(result).toMatchObject({ source: 'native', output: compactedWindow });
    expect(JSON.parse(result.safety).rows[1]).toEqual(['call_1', 'execute_command', 'inspect_1', 'unknown', true, -1]);
    expect(context.buildInput()).toEqual(before);
    expect(options.onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usage: { input_tokens: 2000,
      output_tokens: 200, total_tokens: 2200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }));
  });

  it('keeps every retained item and all 86 statuses, adding guards without pruning the canonical prefix', async () => {
    const { context, options } = setup(86);
    const retained = [...compactedWindow, functionCall('settled'),
      { type: 'function_call_output' as const, call_id: 'settled', output: 'EXACT_RECENT_OUTPUT' }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(compactReply(retained));
    const result = await prepareContextCheckpoint(options);
    context.replaceWithCompaction(result.output, result.safety);
    const next = context.buildInput();
    expect(next.slice(0, retained.length)).toEqual(retained);
    expect(JSON.parse(result.safety).rows).toHaveLength(86);
    expect(JSON.parse(result.safety).rows[43][2]).toBe('inspect_43');
    expect(JSON.stringify(next)).toContain('never change firewall rules');
    expect(JSON.stringify(next)).toContain('EXACT_RECENT_OUTPUT');
  });

  it('does not compact open tool transactions', async () => {
    const { context, options } = setup();
    const call = functionCall();
    context.accept({ id: 'pending', text: '', calls: [call], output: [call] }, context.buildInput());
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_budget' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([404, 405, 501])('pauses on unavailable compact HTTP %s without claiming proven non-support', async status => {
    const { context, options } = setup();
    const before = context.buildInput();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('SECRET', { status }));
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_compaction_unavailable', status,
      diagnostics: { purpose: 'checkpoint', stage: 'http' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(context.buildInput()).toEqual(before);
  });

  it.each([
    {}, { ...compactObject(), object: 'response' }, { ...compactObject(), output: [] },
    { ...compactObject(), output: [{ type: 'compaction', id: 'cmp_bad', encrypted_content: '' }] },
    { ...compactObject(), output: [...compactedWindow, { type: 'message', role: 'system', content: [] }] },
    { ...compactObject(), output: [...compactedWindow, { type: 'web_search_call', id: 'hosted' }] },
    { ...compactObject(), output: [...compactedWindow, { ...functionCall(), status: 'in_progress' }] },
    { ...compactObject(), status: 'incomplete' },
  ])('rejects malformed or unsupported native windows atomically (%#)', async value => {
    const { context, options } = setup();
    const before = context.buildInput();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(value)));
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_invalid' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(context.buildInput()).toEqual(before);
  });

  it('keeps the old history if the complete next main request cannot fit', async () => {
    const { context, options } = setup();
    const before = context.buildInput();
    options.canContinue.mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(compactReply());
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_budget' });
    expect(context.buildInput()).toEqual(before);
  });

  it('bounds HTTP retries and preserves the same body and idempotency key', async () => {
    vi.useFakeTimers();
    const { options } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(compactReply());
    const pending = prepareContextCheckpoint(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).source).toBe('native');
    const requests = fetch.mock.calls.map(([, init]) => init!);
    expect(requests[0].body).toBe(requests[1].body);
    expect(requests[0].headers).toEqual(requests[1].headers);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('cancels a stalled compact without replacing history (reset=%s)', async reset => {
    vi.useFakeTimers();
    const { context, options, controller } = setup();
    const before = context.buildInput();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = prepareContextCheckpoint(options);
    const checked = reset ? expect(pending).rejects.toBe('reset')
      : expect(pending).rejects.toMatchObject({ code: 'responses_timeout' });
    await vi.advanceTimersByTimeAsync(0);
    if (reset) controller.abort('reset');
    else await vi.advanceTimersByTimeAsync(CHECKPOINT_DEADLINE_MS);
    await checked;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(context.buildInput()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects redirects without forwarding credentials, and bounds returned bodies', async () => {
    const { options } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 302,
      headers: { Location: 'https://evil.example' } }));
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_redirect' });
    expect(fetch.mock.calls[0][1]!.redirect).toBe('manual');
    fetch.mockResolvedValueOnce(new Response('x'.repeat(1_000_001)));
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_invalid' });
  });
});
