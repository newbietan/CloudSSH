import type { Env } from '../../types';
import { ResponsesError } from './responses-client';
import type { AgentMemoryProvider, UnifiedServerMemory } from './types';

/** The SSH session only reads memory and submits completed conversation for later summarization. */
export function createAgentMemoryProvider(env: Env, githubId: string, userId: string, serverId: number): AgentMemoryProvider {
  const root = `http://internal/internal/servers/${serverId}`;
  async function request(path: string, body?: unknown, parent?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort('memory_timeout'), 10_000);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ResponsesError('responses_memory_storage'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([cancelled, (async () => {
        const stub = env.USER_DB.get(env.USER_DB.idFromName(githubId));
        const response = await stub.fetch(new Request(root + path, { signal,
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined ? {} : { body: JSON.stringify({ user_id: Number(userId), task: body }) }) }));
        if (!response.ok) {
          void response.body?.cancel();
          throw new ResponsesError('responses_memory_storage', response.status);
        }
        return response.json();
      })()]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  return {
    fetchUnifiedMemory: async signal => await request(`/memory?user_id=${userId}`, undefined, signal) as UnifiedServerMemory,
    enqueueMemory: async task => { await request('/agent-memory', task); },
  };
}
