import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentMemoryProvider } from '../../../src/worker/agent/memory-provider';
import type { MemoryTask } from '../../../src/worker/agent/types';

function setup(response: () => Promise<Response>) {
  const fetch = vi.fn(async (_request: Request) => response());
  const provider = createAgentMemoryProvider({ USER_DB: { idFromName: (name: string) => name,
    get: () => ({ fetch }) } } as never, 'owner', '10', 1);
  return { provider, fetch };
}
afterEach(() => vi.useRealTimers());
const task: MemoryTask = { taskId: 'task-1', goal: '部署', conversation: '使用提供的密钥完成部署', locale: 'zh-CN', timezone: 'UTC' };

describe('Memory provider', () => {
  it('submits the conversation to its saved server without a second local queue', async () => {
    const { provider, fetch } = setup(async () => Response.json({ success: true }));
    await provider.enqueueMemory(task);
    expect(fetch.mock.calls[0][0].url).toBe('http://internal/internal/servers/1/agent-memory');
    expect(await fetch.mock.calls[0][0].json()).toEqual({ user_id: 10, task });
  });

  it('reports storage failures instead of pretending memory was read or saved', async () => {
    const { provider } = setup(async () => new Response('failed', { status: 500 }));
    await expect(provider.fetchUnifiedMemory()).rejects.toMatchObject({ code: 'responses_memory_storage' });
    await expect(provider.enqueueMemory(task)).rejects.toMatchObject({ code: 'responses_memory_storage' });
  });

  it('does not leave a stuck storage call running indefinitely', async () => {
    vi.useFakeTimers();
    const { provider } = setup(async () => new Promise(() => {}));
    const checked = expect(provider.fetchUnifiedMemory()).rejects.toMatchObject({ code: 'responses_memory_storage' });
    await vi.advanceTimersByTimeAsync(10_000); await checked;
    expect(vi.getTimerCount()).toBe(0);
  });
});
