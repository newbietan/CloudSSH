import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareContextCheckpoint, CHECKPOINT_DEADLINE_MS } from '../../../src/worker/agent/checkpoint';
import { AgentContext } from '../../../src/worker/agent/context';
import type { OperationFact } from '../../../src/worker/agent/execution-journal';
import { ResponsesClient } from '../../../src/worker/agent/responses-client';
import type { ModelResponse, ResponseInput } from '../../../src/worker/agent/types';
import { aiConfig, functionCall, responseObject } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(factCount = 3) {
  const context = new AgentContext();
  context.beginTurn('Inspect nginx; never change firewall rules.');
  const model: ModelResponse = { id: 'accepted', text: 'Inspecting', output: [], calls: [] };
  context.accept(model, context.buildInput());

  const facts: OperationFact[] = Array.from({ length: factCount }, (_, i) => ({
    taskId: 'task', callId: `call_${i}`,
    tool: 'execute_command', description: `inspect_${i}`, status: i === 1 ? 'unknown' : 'succeeded',
    executed: true, exitCode: i === 1 ? -1 : 0, evidence: `observed_${i}`, at: i,
  }));
  const controller = new AbortController();
  const client = new ResponsesClient(aiConfig);
  const options = {
    context,
    client,
    instructions: 'Stable trusted system instructions',
    facts,
    signal: controller.signal,
    canContinue: vi.fn((input: ResponseInput[]) => context.fitsBudget(55_808, 'Stable', input)),
    onUsage: vi.fn(),
  };
  return { context, facts, controller, options };
}

describe('Application-level context compaction with recent tail preservation', () => {
  it('calls standard /responses with summarization instructions and returns model summary + retained tail', async () => {
    const { context, options } = setup();
    // Simulate multiple turns and completed tool transactions
    for (let i = 0; i < 5; i++) {
      context.beginTurn(`Step ${i}`);
      const call = functionCall(`call_step_${i}`);
      context.accept({ id: `resp_${i}`, text: `Running step ${i}`, output: [call], calls: [call] }, context.buildInput());
      context.toolResult(call, `Output for step ${i}: version=1.${i}.0`);
    }

    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe(aiConfig.base_url + '/responses');
      const body = JSON.parse(init!.body as string);
      expect(body.stream).toBe(false);
      expect(body.max_output_tokens).toBe(1500);
      expect(body.reasoning).toEqual({ effort: 'low' });
      expect(body.instructions).toContain('紧凑总结');
      return Response.json(responseObject('resp_summary', 'Successfully summarized earlier steps; nginx inspected.'));
    });

    const result = await prepareContextCheckpoint(options);
    expect(result.source).toBe('model');
    expect(result.summary).toContain('nginx inspected');
    expect(result.retained.length).toBeGreaterThan(0);
    // Recent verbatim items preserved
    expect(JSON.stringify(result.retained)).toContain('version=');
    expect(JSON.parse(result.safety).rows).toHaveLength(3);
    expect(options.onUsage).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('smoothly falls back to local execution facts if model summarization fails', async () => {
    const { context, options } = setup();
    for (let i = 0; i < 6; i++) {
      context.beginTurn(`Turn ${i}`);
      context.accept({ id: `r_${i}`, text: `Done ${i}`, output: [], calls: [] }, context.buildInput());
    }

    // Provider returns 500 or 400 for whatever reason
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Temporary failure', { status: 500 }));

    const result = await prepareContextCheckpoint(options);
    expect(result.source).toBe('local');
    expect(result.summary).toBeTruthy();
    expect(result.safety).toContain('inspect_0');
  });

  it('does not compact while tool transactions are still open', async () => {
    const { context, options } = setup();
    const call = functionCall();
    context.accept({ id: 'pending', text: '', calls: [call], output: [call] }, context.buildInput());
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_budget' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps history intact if even minimal continuation exceeds available budget', async () => {
    const { context, options } = setup();
    const before = context.buildInput();
    options.canContinue.mockReturnValue(false);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseObject('resp_s', 'Summary.')));
    await expect(prepareContextCheckpoint(options)).rejects.toMatchObject({ code: 'responses_budget' });
    expect(context.buildInput()).toEqual(before);
  });

  it.each([false, true])('respects abort signal and 60s timeout without corrupting context (reset=%s)', async reset => {
    vi.useFakeTimers();
    const { context, options, controller } = setup();
    for (let i = 0; i < 5; i++) {
      context.beginTurn(`Turn ${i}`);
      context.accept({ id: `r_${i}`, text: `Done ${i}`, output: [], calls: [] }, context.buildInput());
    }
    const before = context.buildInput();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));

    const pending = prepareContextCheckpoint(options);
    const checked = reset ? expect(pending).rejects.toBe('reset')
      : expect(pending).rejects.toMatchObject({ code: 'responses_timeout' });
    await vi.advanceTimersByTimeAsync(0);
    if (reset) controller.abort('reset');
    else await vi.advanceTimersByTimeAsync(CHECKPOINT_DEADLINE_MS);
    await checked;
    expect(context.buildInput()).toEqual(before);
  });
});
