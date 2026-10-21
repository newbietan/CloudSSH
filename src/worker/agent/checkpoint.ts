import { AgentContext, observation } from './context';
import { COMPACTION_PROMPT } from './prompt';
import { ResponsesClient, ResponsesError, type ResponseRequest } from './responses-client';
import type { ModelResponse, ResponseInput } from './types';

interface CheckpointOptions {
  context: AgentContext;
  client: ResponsesClient;
  signal: AbortSignal;
  canContinue: (input: ResponseInput[]) => boolean;
  onUsage: (response: ModelResponse) => void;
}

/** Summarize old conversation and keep recent exchanges; no separate execution ledger. */
export async function prepareContextCheckpoint(options: CheckpointOptions): Promise<{
  summary: string; recent: ResponseInput[]; source: 'model' | 'local';
}> {
  const { context, client, signal } = options;
  signal.throwIfAborted();
  const { older, recent } = context.splitForCompaction();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort('summary_timeout'), 20_000);
  let summary = context.formatItemsForCompaction(12 * 1024, older) || 'Continue from the recent conversation.';
  let source: 'model' | 'local' = 'local';
  try {
    if (older.length || context.summary) {
      const request: ResponseRequest = { purpose: 'checkpoint', stream: false, instructions: COMPACTION_PROMPT,
        input: [], max_output_tokens: 1500, reasoning: { effort: 'low' } };
      for (const budget of [48 * 1024, 16 * 1024, 4 * 1024]) {
        request.input = [observation('conversation to summarize', context.formatItemsForCompaction(budget, older))];
        if (client.canFit(request)) break;
      }
      try {
        const response = await client.create(request, AbortSignal.any([signal, timeout.signal]));
        signal.throwIfAborted();
        options.onUsage(response);
        if (response.text.trim()) { summary = response.text.trim(); source = 'model'; }
      } catch { signal.throwIfAborted(); }
    }
    if (!options.canContinue(context.checkpointSegment(summary, recent))) {
      throw new ResponsesError('responses_budget', undefined, { purpose: 'checkpoint' });
    }
    return { summary, recent, source };
  } finally { clearTimeout(timer); timeout.abort('summary_finished'); }
}
