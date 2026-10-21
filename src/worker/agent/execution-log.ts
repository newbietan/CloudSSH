import type { AgentLocale } from './prompt';
import type { OperationFact } from './execution-journal';
import { redactEvidence } from './execution-journal';
import { boundedText } from './context-limits';
import type { AgentExecutionLog, RunOutcome } from './types';

/** Program facts only. A model outage or invalid memory JSON cannot erase this record. */
export function buildExecutionLog(taskId: string, goal: string, facts: OperationFact[], outcome: RunOutcome,
  step: number, locale: AgentLocale): AgentExecutionLog {
  const counts = new Map<string, number>();
  for (const fact of facts) counts.set(fact.status, (counts.get(fact.status) ?? 0) + 1);
  const interrupted = outcome !== 'completed';
  const prefix = !interrupted ? '' : locale === 'en-US' ? '[Interrupted] ' : locale === 'zh-TW' ? '[已中斷] ' : '[已中断] ';
  const last = facts.at(-1);
  const summary = `${outcome}; ${[...counts].map(([status, count]) => `${status}=${count}`).join('; ')}.` +
    (last ? ` Last: ${last.description} (${last.status}, exit=${last.exitCode ?? '-'}).` : '');
  return { taskId, goal: boundedText(prefix + redactEvidence(goal), 64), summary: boundedText(summary, 300),
    operations: facts.map(fact => ({ callId: fact.callId, tool: fact.tool, description: fact.description,
      status: fact.status, executed: fact.executed, exitCode: fact.exitCode, at: fact.at })),
    outcome, step, updatedAt: Date.now() };
}
