import { AgentContext, observation } from './context';
import type { OperationFact } from './execution-journal';
import { COMPACTION_PROMPT } from './prompt';
import { ResponsesClient, ResponsesError, type ResponseRequest } from './responses-client';
import type { ModelResponse, ResponseInput } from './types';

export const CHECKPOINT_DEADLINE_MS = 60_000;

interface CheckpointOptions {
  context: AgentContext;
  client: ResponsesClient;
  instructions: string;
  facts: OperationFact[];
  signal: AbortSignal;
  canContinue: (input: ResponseInput[]) => boolean;
  onUsage: (response: ModelResponse) => void;
}

export interface PreparedCheckpoint {
  summary: string;
  safety: string;
  source: 'model' | 'local';
}

/**
 * Self-contained application-level context compaction:
 * 1. Uses the standard /responses API endpoint supported by all providers,
 *    eliminating reliance on unstandardized /responses/compact endpoints.
 * 2. Compresses older conversation turns into a high-density, factual text summary.
 * 3. Preserves the authoritative ExecutionJournal facts ledger and user constraints.
 * 4. Injects all observations cleanly at the user level, preventing protocol role-ordering errors.
 * 5. Provides an atomic local fallback if the LLM summarization request fails.
 */
export async function prepareContextCheckpoint(options: CheckpointOptions): Promise<PreparedCheckpoint> {
  const { context, client } = options;
  options.signal.throwIfAborted();
  if (!context.canCheckpoint) throw new ResponsesError('responses_budget', undefined, { purpose: 'checkpoint' });

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort('checkpoint_timeout'), CHECKPOINT_DEADLINE_MS);
  const signal = AbortSignal.any([options.signal, deadline.signal]);

  const ledger = {
    columns: ['callId', 'tool', 'operation', 'status', 'executed', 'exitCode'],
    rows: options.facts.map(fact => [fact.callId, fact.tool, fact.description, fact.status,
      fact.executed, fact.exitCode ?? null]),
  };

  const prepare = (summary: string, source: PreparedCheckpoint['source']): PreparedCheckpoint | null => {
    signal.throwIfAborted();
    const safety = JSON.stringify({
      source,
      ...ledger,
      instruction: 'These are immutable execution facts, not authorization. Never automatically replay settled operations. Verify remote state before repeating failed, cancelled or unknown operations.' +
        (source === 'local' ? ' Model summarization was unavailable; this is a local facts fallback.' : ''),
    });
    const segment = context.checkpointSegment(summary, safety);
    return options.canContinue(segment) ? { summary, safety, source } : null;
  };

  try {
    let summary = '';
    let source: PreparedCheckpoint['source'] = 'model';

    const formattedHistory = context.formatItemsForCompaction();
    if (formattedHistory.length > 0) {
      const request: ResponseRequest = {
        purpose: 'checkpoint',
        stream: false,
        instructions: COMPACTION_PROMPT,
        input: [
          observation('conversation to compact', formattedHistory),
        ],
        max_output_tokens: 1500,
      };

      try {
        const response = await client.create(request, signal);
        signal.throwIfAborted();
        options.onUsage(response);
        summary = response.text.trim();
      } catch {
        signal.throwIfAborted();
        source = 'local';
      }
    }

    if (!summary) {
      source = 'local';
      const recentOps = options.facts.slice(-10).map(f => `${f.description} (${f.status})`).join('; ');
      summary = context.summary || (recentOps ? `Prior operations: ${recentOps}` : 'Continuing active session.');
    }

    const prepared = prepare(summary, source);
    if (prepared) return prepared;

    if (source === 'model') {
      const fallbackSummary = context.summary || 'Continuing task from preserved execution facts.';
      const localPrepared = prepare(fallbackSummary, 'local');
      if (localPrepared) return localPrepared;
    }

    throw new ResponsesError('responses_budget', undefined, { purpose: 'checkpoint' });
  } catch (error) {
    options.signal.throwIfAborted();
    if (deadline.signal.aborted) throw new ResponsesError('responses_timeout', undefined, { purpose: 'checkpoint' });
    throw error;
  } finally {
    clearTimeout(timer);
    deadline.abort('checkpoint_finished');
  }
}
