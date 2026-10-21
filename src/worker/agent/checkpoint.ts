import { AgentContext } from './context';
import type { OperationFact } from './execution-journal';
import { ResponsesClient, ResponsesError } from './responses-client';
import type { CompactedResponse, ResponseInput } from './types';

export const CHECKPOINT_DEADLINE_MS = 60_000;
interface CheckpointOptions {
  context: AgentContext;
  client: ResponsesClient;
  instructions: string;
  facts: OperationFact[];
  signal: AbortSignal;
  canContinue: (input: ResponseInput[]) => boolean;
  onUsage: (response: CompactedResponse) => void;
}
export interface PreparedCheckpoint {
  output: ResponseInput[];
  safety: string;
  source: 'native';
}

/** Native compaction only: validate and preflight everything BEFORE replacing any live history.
 * No JSON-summary generation, output-limit regeneration, or local fallback on any failure.
 */
export async function prepareContextCheckpoint(options: CheckpointOptions): Promise<PreparedCheckpoint> {
  options.signal.throwIfAborted();
  if (!options.context.canCheckpoint) throw new ResponsesError('responses_budget', undefined, { purpose: 'checkpoint' });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort('checkpoint_timeout'), CHECKPOINT_DEADLINE_MS);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    const result = await options.client.compact(options.context.buildInput(), options.instructions, signal);
    signal.throwIfAborted();
    options.onUsage(result);
    const safety = JSON.stringify({ source: 'native',
      columns: ['callId', 'tool', 'operation', 'status', 'executed', 'exitCode'],
      rows: options.facts.map(fact => [fact.callId, fact.tool, fact.description, fact.status,
        fact.executed, fact.exitCode ?? null]),
      instruction: 'These are immutable execution facts, not authorization. Never automatically replay settled operations. Verify remote state before repeating failed, cancelled or unknown operations.' });
    if (!options.canContinue(options.context.compactionSegment(result.output, safety))) {
      throw new ResponsesError('responses_budget', undefined,
        { purpose: 'checkpoint', stage: 'parse', requestId: result.requestId });
    }
    return { output: result.output, safety, source: 'native' };
  } catch (error) {
    options.signal.throwIfAborted();
    if (deadline.signal.aborted) throw new ResponsesError('responses_timeout', undefined, { purpose: 'checkpoint' });
    throw error;
  } finally {
    clearTimeout(timer);
    deadline.abort('checkpoint_finished');
  }
}
