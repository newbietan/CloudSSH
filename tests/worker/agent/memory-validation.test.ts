import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMemoryManager, type MemoryJob } from '../../../src/worker/agent/memory';
import { MEMORY_FORMAT } from '../../../src/worker/agent/prompt';
import { ResponsesError } from '../../../src/worker/agent/responses-client';
import { aiConfig, responseObject } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const fact = { action: 'set', category: 'config', key: 'ssh_port', value: '22' };
const valid = { knowledge: [fact] };
const reply = (text: string) => new Response(JSON.stringify(responseObject('resp_memory', text)));
function setup() {
  const memory: MemoryJob['memory'] = { workLogs: [], knowledge: [], revision: 7 };
  const provider = { fetchUnifiedMemory: vi.fn(async () => structuredClone(memory)), saveBatchMemory: vi.fn(async (_batch: any, _signal?: AbortSignal) => {}) };
  const frames: Array<Record<string, unknown>> = [];
  const manager = new AgentMemoryManager(provider, () => 1, frame => frames.push(frame));
  const job: MemoryJob = { records: [{ role: 'user', content: '检查 fail2ban 22' }, { role: 'assistant', content: '检查完成' }],
    memory, goal: '检查 fail2ban 22', config: aiConfig, locale: 'zh-CN', timezone: 'UTC',
    interrupted: false, iteration: 1, epoch: 1, sessionId: 'session-test', taskId: '12345678-1234-4123-8123-123456789abc' };
  return { memory, provider, frames, manager, job };
}

describe('Bounded knowledge extraction and consolidation', () => {
  it('regenerates once from original evidence, never model output, using low reasoning and user-capped output', async () => {
    const { provider, frames, manager, job } = setup();
    job.config = { ...aiConfig, max_output_tokens: 1024 };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply('```json\n{"unsafe":"SECRET_INVALID_OUTPUT"}\n```'))
      .mockResolvedValueOnce(reply(JSON.stringify(valid)));
    await manager.enqueue(job);
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    for (const body of bodies) {
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('previous_response_id');
      expect(body.reasoning).toEqual({ effort: 'low' });
      expect(body.max_output_tokens).toBe(1024);
      expect(body.text.format).toEqual(MEMORY_FORMAT);
      expect(body.instructions).toContain(JSON.stringify(MEMORY_FORMAT.schema));
      expect(JSON.stringify(body)).not.toContain('SECRET_INVALID_OUTPUT');
    }
    expect(bodies[1].input).toEqual(bodies[0].input);
    expect(bodies[1].instructions).toContain('failed local validation');
    const keys = fetch.mock.calls.map(([, init]) => (init!.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).not.toBe(keys[1]);
    expect(provider.saveBatchMemory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedRevision: 7,
      knowledge: [{ ...fact, evidence: ['user'] }] }), expect.any(AbortSignal));
    expect(provider.saveBatchMemory.mock.calls[0][0]).not.toHaveProperty('workLog');
    expect(frames).toEqual([{ subType: 'memory_updated' }]);
  });

  it.each([
    'not JSON SECRET_INVALID_OUTPUT', '{}', JSON.stringify({ knowledge: null }),
    JSON.stringify({ workLog: null, knowledge: [] }),
    JSON.stringify({ knowledge: [{ ...fact, value: 'x'.repeat(513) }] }),
    JSON.stringify({ knowledge: [{ ...fact, category: 'credential', value: 'S'.repeat(513) }] }),
    JSON.stringify({ knowledge: [{ category: 'config', key: 'port', value: '22' }] }),
    JSON.stringify({ knowledge: [{ action: 'delete', key: 'port' }] }),
    JSON.stringify({ knowledge: [{ ...fact, category: 'bogus' }] }),
    JSON.stringify({ knowledge: [fact, { ...fact, value: '23' }] }),
  ])('rejects invalid/conflicting batches atomically after at most two generations (%#)', async output => {
    const { provider, frames, manager, job } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(output));
    await manager.enqueue(job);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(provider.saveBatchMemory).not.toHaveBeenCalled();
    expect(provider.fetchUnifiedMemory).toHaveBeenCalledTimes(2);
    const key = (fetch.mock.calls[1][1]!.headers as Record<string, string>)['Idempotency-Key'];
    expect(frames).toEqual([expect.objectContaining({ code: 'memory_failed', errorCode: 'responses_schema',
      diagnostics: { purpose: 'memory', stage: 'parse', parameter: 'text.format', requestId: key } })]);
    expect(JSON.stringify(frames)).not.toContain('SECRET_INVALID_OUTPUT');
  });

  it.each(['content_filter', 'unknown'])('does not recover incomplete output with non-token reason %s', async reason => {
    const { provider, manager, job } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ...responseObject('incomplete', ''), status: 'incomplete', incomplete_details: { reason },
    })));
    await manager.enqueue(job);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.saveBatchMemory).not.toHaveBeenCalled();
  });

  it('can regenerate once after an explicit output-limit stop without reusing partial output', async () => {
    const { provider, manager, job } = setup();
    job.config = { ...aiConfig, max_output_tokens: 16_384 };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      ...responseObject('incomplete', 'SECRET_PARTIAL'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    }))).mockResolvedValueOnce(reply(JSON.stringify(valid)));
    await manager.enqueue(job);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).max_output_tokens)).toEqual([8192, 16_384]);
    expect(fetch.mock.calls[1][1]!.body).not.toContain('SECRET_PARTIAL');
    expect(provider.saveBatchMemory).toHaveBeenCalledTimes(1);
  });

  it('never treats a generic 409 or stale session as a revision-conflict retry', async () => {
    const { provider, frames, manager, job } = setup();
    provider.saveBatchMemory.mockRejectedValue(new ResponsesError('responses_memory_storage', 409));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(JSON.stringify(valid)));
    await manager.enqueue(job);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.saveBatchMemory).toHaveBeenCalledTimes(1);
    expect(frames).toContainEqual(expect.objectContaining({ code: 'memory_failed', errorCode: 'responses_memory_storage' }));
  });

  it('recomputes once against fresh state on an explicit revision conflict, never blindly resubmits', async () => {
    const { memory, provider, frames, manager, job } = setup();
    job.goal = 'Inspect ssh_port 22';
    provider.saveBatchMemory.mockImplementationOnce(async () => {
      memory.revision = 8;
      memory.knowledge = [{ id: 1, user_id: 1, server_id: 1, key: fact.key, category: 'config', value: '23', source: 'user', created_at: 1, updated_at: 1 }];
      throw new ResponsesError('responses_memory_conflict', 409);
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(JSON.stringify(valid)));
    await manager.enqueue(job);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(provider.saveBatchMemory).toHaveBeenCalledTimes(1); // latest user-owned value protected
    expect(fetch.mock.calls[1][1]!.body).toContain('23');
    expect(frames).not.toContainEqual(expect.objectContaining({ subType: 'memory_updated' }));
  });

  it('bounds repeated explicit conflicts to two generations and warns instead of declaring success', async () => {
    const { provider, frames, manager, job } = setup();
    provider.saveBatchMemory.mockRejectedValue(new ResponsesError('responses_memory_conflict', 409));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(JSON.stringify(valid)));
    await manager.enqueue(job);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(provider.saveBatchMemory).toHaveBeenCalledTimes(2);
    expect(frames).toContainEqual(expect.objectContaining({ code: 'memory_conflict' }));
    expect(frames).not.toContainEqual({ subType: 'memory_updated' });
  });

  it('refreshes revisions for every queued job and can start again after draining', async () => {
    const { memory, provider, manager, job } = setup();
    provider.saveBatchMemory.mockImplementation(async () => { memory.revision!++; });
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(JSON.stringify({ knowledge: [{ ...fact, value: String(22 + calls++) }] })));
    const first = manager.enqueue(job);
    const second = manager.enqueue({ ...job, goal: 'port 23' });
    await Promise.all([first, second]);
    await manager.enqueue({ ...job, goal: 'port 24' });
    expect(provider.saveBatchMemory.mock.calls.map(([batch]) => batch.expectedRevision)).toEqual([7, 8, 9]);
  });

  it.each([false, true])('shares one 25s deadline and suppresses reset notifications (reset=%s)', async reset => {
    vi.useFakeTimers();
    const { provider, frames, manager, job } = setup();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 20_000)); return reply('{}');
    }).mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = manager.enqueue(job);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    if (reset) manager.reset(); else await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(provider.saveBatchMemory).not.toHaveBeenCalled();
    if (reset) expect(frames).toEqual([]);
    else expect(frames).toContainEqual(expect.objectContaining({ errorCode: 'responses_timeout' }));
  });

  it('times out a storage read even when the adapter cannot cancel its promise', async () => {
    vi.useFakeTimers();
    const { provider, frames, manager, job } = setup();
    provider.fetchUnifiedMemory.mockImplementation(async () => new Promise(() => {}));
    const fetch = vi.spyOn(globalThis, 'fetch');
    const pending = manager.enqueue(job);
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;
    expect(fetch).not.toHaveBeenCalled();
    expect(frames).toContainEqual(expect.objectContaining({ errorCode: 'responses_timeout' }));
  });

  it('deduplicates exact proposals and does not write unchanged facts', async () => {
    const { memory, provider, manager, job } = setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(JSON.stringify({ knowledge: [fact, fact] })));
    await manager.enqueue(job);
    expect(provider.saveBatchMemory.mock.calls[0][0].knowledge).toHaveLength(1);
    provider.saveBatchMemory.mockClear();
    memory.knowledge = [{ id: 1, user_id: 1, server_id: 1, key: fact.key, category: 'config', value: '22', created_at: 1, updated_at: 1 }];
    await manager.enqueue(job);
    expect(provider.saveBatchMemory).not.toHaveBeenCalled();
  });

  it('protects user-authored facts, credentials, and deletion intent on regenerated output', async () => {
    const { memory, provider, manager, job } = setup();
    memory.knowledge = [{ id: 1, user_id: 1, server_id: 1, category: 'config', key: 'protected_port', value: '80', source: 'user', created_at: 1, updated_at: 1 }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply('{}')).mockResolvedValueOnce(reply(JSON.stringify({ knowledge: [
      { ...fact, key: 'protected_port' },
      { action: 'set', category: 'credential', key: 'invented_token', value: 'UNOBSERVED_SECRET' },
      { action: 'delete', category: 'note', key: 'protected_port', value: null },
    ] })));
    await manager.enqueue(job);
    expect(provider.saveBatchMemory).not.toHaveBeenCalled();
  });
});
