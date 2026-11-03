import { AgentContext, observation } from './context';
import { boundedToolOutput, bytes } from './context-limits';
import { COMPACTION_PROMPT } from './prompt';
import { ResponsesClient, ResponsesError, type ResponseRequest } from './responses-client';
import type { ModelResponse, ResponseFunctionCall, ResponseInput } from './types';

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
    const fitted = fitContinuation(context, summary, recent, options.canContinue);
    return { summary: fitted.summary, recent: fitted.recent, source };
  } finally { clearTimeout(timer); timeout.abort('summary_finished'); }
}

/** Drop older recent exchanges, then shorten the newest tool output, until the next request fits. */
function fitContinuation(
  context: AgentContext,
  initialSummary: string,
  recent: ResponseInput[],
  canContinue: (input: ResponseInput[]) => boolean
): { summary: string; recent: ResponseInput[] } {
  let summary = initialSummary;
  let groups = exchangeGroups(recent);
  let phase: 'drop' | 'tighten' | 'fold' | 'fail' = groups.length > 1 ? 'drop' : 'tighten';
  while (!canContinue(context.checkpointSegment(summary, groups.flat()))) {
    if (phase === 'drop' && groups.length > 1) {
      const dropped = groups.shift()!;
      summary = mergeSummary(summary, context.formatItemsForCompaction(8 * 1024, dropped));
      continue;
    }
    if (phase === 'drop' || phase === 'tighten') {
      groups = groups.map(group => group.map(shortenToolOutput));
      phase = 'fold';
      continue;
    }
    if (phase === 'fold' && groups.length) {
      summary = mergeSummary(summary, context.formatItemsForCompaction(8 * 1024, groups.flat()));
      groups = [];
      phase = 'fail';
      continue;
    }
    throw new ResponsesError('responses_budget', undefined, { purpose: 'checkpoint' });
  }
  return { summary, recent: groups.flat() };
}

function exchangeGroups(items: ResponseInput[]): ResponseInput[][] {
  const groups: ResponseInput[][] = [];
  let group: ResponseInput[] = [];
  const calls = new Set<string>();
  for (const item of items) {
    if ('role' in item && item.role === 'user' && typeof item.content === 'string' &&
      !item.content.startsWith('[UNTRUSTED OBSERVATION:') && group.length && !calls.size) {
      groups.push(group); group = [];
    }
    group.push(item);
    if ('type' in item && item.type === 'function_call') calls.add((item as ResponseFunctionCall).call_id);
    if ('type' in item && item.type === 'function_call_output') {
      calls.delete(item.call_id);
      if (!calls.size) { groups.push(group); group = []; }
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

function shortenToolOutput(item: ResponseInput): ResponseInput {
  if ('type' in item && item.type === 'function_call_output' && bytes(item.output) > 4096) {
    return { ...item, output: boundedToolOutput(item.output, 4096) };
  }
  return item;
}

function mergeSummary(current: string, extra: string): string {
  const joined = `${current}\n\n${extra}`.trim();
  if (bytes(joined) <= 12 * 1024) return joined;
  return `${current.slice(0, 6000)}\n\n${extra.slice(-4000)}`.trim();
}
