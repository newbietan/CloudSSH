import type { AgentTaskCheckpoint } from '../../agent-task-schema';
import type { Env } from '../../types';
import { ResponsesError } from './responses-client';
import type { AgentMemoryProvider, UnifiedServerMemory } from './types';

/** Internal storage failures are not successful writes. Never forward raw storage errors. */
export function createAgentMemoryProvider(env: Env, githubId: string, userId: string, serverId: number): AgentMemoryProvider {
  const root = `http://internal/internal/servers/${serverId}`;
  const request = async (path: string, method: string, body?: unknown, parent?: AbortSignal, read = false): Promise<unknown> => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort('memory_storage_timeout'), 10_000);
    const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
    let response: Response | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        void response?.body?.cancel().catch(() => {});
        reject(new ResponsesError('responses_memory_storage', undefined, { purpose: 'memory' }));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      signal.throwIfAborted();
      return await Promise.race([cancelled, (async () => {
        const stub = env.USER_DB.get(env.USER_DB.idFromName(githubId));
        const res = await stub.fetch(new Request(root + path, { method, signal,
          ...(body == null ? {} : { headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: Number(userId), ...body as Record<string, unknown> }) }) }));
        response = res;
        signal.throwIfAborted();
        if (!res.ok) {
          let revisionConflict = false;
          if (res.status === 409) {
            // Only this machine code can trigger regeneration, never generic/stale-session 409s.
            const raw = await res.json<{ code?: unknown }>();
            revisionConflict = raw.code === 'memory_revision_conflict';
          } else void res.body?.cancel();
          throw new ResponsesError(revisionConflict ? 'responses_memory_conflict' : 'responses_memory_storage', res.status,
            { purpose: 'memory' });
        }
        if (read) return await res.json();
        void res.body?.cancel();
      })()]);
    } catch (error) {
      if (error instanceof ResponsesError) throw error;
      throw new ResponsesError('responses_memory_storage', undefined, { purpose: 'memory' });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
  const write = async (path: string, method: string, body: unknown, signal?: AbortSignal): Promise<void> => {
    await request(path, method, body, signal);
  };
  return {
    fetchUnifiedMemory: async signal => await request(`/memory?user_id=${userId}`, 'GET', undefined, signal, true) as UnifiedServerMemory,
    saveBatchMemory: (batch, signal) => write('/memory/batch', 'POST', batch, signal),
    saveExecutionLog: (entry, context, signal) => write('/agent-execution', 'POST', { entry, ...context }, signal),
    beginSession: context => write('/agent-session', 'POST', context),
    saveTaskCheckpoint: (checkpoint, context) => write('/agent-checkpoint', 'POST', { checkpoint, ...context }),
    fetchTaskCheckpoint: async taskId => await request(`/agent-checkpoint?user_id=${userId}&task_id=${taskId}`, 'GET', undefined, undefined, true) as AgentTaskCheckpoint,
    deleteTaskCheckpoint: (taskId, context) => write('/agent-checkpoint', 'DELETE', { taskId, ...context }),
  };
}
