import { boundedText, boundedUtf8, bytes } from './context-limits';
import { ResponsesError } from './responses-client';
import { executionOutcome } from './tool-executor';
import type { ExecutionStatus, ResponseFunctionCall, TaskRecord } from './types';

export { executionOutcome } from './tool-executor';
const MAX_OPERATIONS = 256;
const MAX_JOURNAL_BYTES = 256 * 1024;

export interface OperationFact {
  taskId: string;
  callId: string;
  tool: string;
  description: string;
  status: ExecutionStatus;
  executed: boolean;
  exitCode?: number;
  evidence: string;
  at: number;
}

export function redactEvidence(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z\s]*PRIVATE KEY-----[\s\S]*?-----END [A-Z\s]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|xox[baprs]-[\w-]{10,})\b/g, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[\w.\-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

function description(call: ResponseFunctionCall): string {
  try {
    const args = JSON.parse(call.arguments);
    if (call.name === 'execute_command') return String(args.command);
    return `${call.name}: ${JSON.stringify(args)}`;
  } catch { return call.name; }
}

export class ExecutionJournal {
  private entries: OperationFact[] = [];

  assertCapacity(count: number): void {
    if (this.entries.length + count > MAX_OPERATIONS || bytes(this.entries) + count * 1024 > MAX_JOURNAL_BYTES) {
      throw new ResponsesError('responses_budget');
    }
  }

  settle(taskId: string, call: ResponseFunctionCall, output: string): OperationFact {
    const outcome = executionOutcome(call.name, output);
    let value: Record<string, unknown> = {};
    try { value = JSON.parse(output); } catch { /* Bounded text tool. */ }
    const evidence = typeof value?.stdout === 'string' ? value.stdout + '\n' + String(value.stderr || '')
      : typeof value?.result === 'string' ? value.result : output;
    const fact: OperationFact = { taskId, callId: boundedUtf8(call.call_id, 80), tool: boundedUtf8(call.name, 64),
      description: boundedUtf8(redactEvidence(description(call)), 256), ...outcome,
      ...(typeof value?.exit_code === 'number' ? { exitCode: value.exit_code } : {}),
      evidence: boundedUtf8(redactEvidence(evidence), 256), at: Date.now() };
    this.entries.push(Object.freeze(fact));
    return fact;
  }

  facts(taskId?: string): OperationFact[] {
    return this.entries.filter(entry => taskId == null || entry.taskId === taskId).map(entry => ({ ...entry }));
  }

  safetyObservation(): string {
    // Never branches/rolls back with model history. Exact statuses cannot be rewritten by summaries.
    return JSON.stringify(this.entries.map(({ evidence: _evidence, ...fact }) => fact));
  }

  taskRecords(taskId: string, goal: string, finalText = ''): TaskRecord[] {
    const records: TaskRecord[] = [{ role: 'user', content: boundedText(goal, 16_000) }];
    for (const fact of this.facts(taskId)) {
      // These are evidence projections, NOT native items for protocol replay.
      records.push({ role: 'assistant', content: '', calls: [{ type: 'function_call',
        id: `evidence_${fact.callId}`, call_id: fact.callId, name: 'execute_command',
        arguments: JSON.stringify({ command: fact.description }), status: 'completed' }] });
      records.push({ role: 'tool', callId: fact.callId, status: fact.status,
        content: JSON.stringify({ status: fact.status, executed: fact.executed, exit_code: fact.exitCode, result: fact.evidence }) });
    }
    if (finalText) records.push({ role: 'assistant', content: boundedText(redactEvidence(finalText), 4000) });
    return records;
  }
}
