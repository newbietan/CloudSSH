import { isSensitiveKeyOrValue, normalizeKnowledgeInput, normalizeWorkLogInput,
  WORK_LOG_TITLE_MAX_LENGTH, type UnifiedServerMemory } from '../../server-memory-schema';
import { boundedText, boundedUtf8, bytes } from './context-limits';
import { observation } from './context';
import { redactEvidence } from './execution-journal';
import { MEMORY_DISTILLATION_PROMPT, MEMORY_FORMAT, type AgentLocale } from './prompt';
import { ResponsesClient, ResponsesError } from './responses-client';
import type { AgentMemoryBatch, AgentMemoryProvider, AIConfig, TaskRecord } from './types';

/** Deterministic relevance; no embedding service, no credential-wide prompt injection. */
export function selectServerMemory(memory: UnifiedServerMemory, goal: string): UnifiedServerMemory {
  const query = goal.toLowerCase();
  const words = new Set(query.match(/[\p{L}\p{N}_./-]{2,}/gu) ?? []);
  for (let i = 0; i < query.length - 1; i++) {
    const pair = query.slice(i, i + 2);
    if (/^[\p{L}\p{N}]{2}$/u.test(pair)) words.add(pair);
  }
  const score = (key: string, value: string) => {
    const name = key.toLowerCase();
    const tokens = name.split(/[_\s-]+/).filter(word => word.length > 1);
    let result = query.includes(name) ? 20 : 0;
    for (const token of tokens) if (query.includes(token)) result += 4;
    for (const word of words) if (name.includes(word) || value.toLowerCase().includes(word)) result++;
    return result;
  };
  const knowledge = memory.knowledge.filter(item => !item.stale).map(item => ({ item,
    score: score(item.key, item.category === 'credential' ? '' : item.value) }));
  const selected = knowledge.filter(({ item, score: rank }) => {
    const sensitive = item.category === 'credential' || isSensitiveKeyOrValue(item.key, item.value);
    return sensitive ? rank >= 4 : rank > 0 || item.category === 'rule';
  }).sort((a, b) => b.score - a.score || b.item.updated_at - a.item.updated_at).slice(0, 20).map(entry => entry.item);
  const historical = /工作|历史|之前|昨天|今天|歷史|operations|history|yesterday|today|recent work/i.test(goal);
  const workLogs = historical ? memory.workLogs.slice(0, 6) : memory.workLogs
    .filter(log => score(log.title, log.summary) > 0).slice(0, 3);
  return { ...memory, knowledge: selected, workLogs };
}

export interface MemoryJob {
  records: TaskRecord[];
  memory: UnifiedServerMemory;
  goal: string;
  config: AIConfig;
  locale: AgentLocale;
  timezone: string;
  interrupted: boolean;
  iteration: number;
  epoch: number;
  sessionId: string;
}
const MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_JOB_BYTES = 512 * 1024;

function parseObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Invalid output never mutates storage. */ }
  throw new ResponsesError('responses_schema');
}

export class AgentMemoryManager {
  private queue: MemoryJob[] = [];
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private lastLogId?: number;

  constructor(private provider: AgentMemoryProvider, private epoch: () => number,
    private emit: (frame: Record<string, unknown>) => void) {}

  reset(): void {
    this.queue = [];
    this.controller?.abort('reset');
    this.lastLogId = undefined;
  }

  enqueue(job: MemoryJob): Promise<void> {
    // FIFO, bounded by bytes AND count. Never silently replace an older pending task.
    if (bytes(job) > MAX_JOB_BYTES || this.queue.length >= 4 || bytes([...this.queue, job]) > MAX_QUEUE_BYTES) {
      this.emit({ subType: 'memory_status', code: 'memory_busy' });
      return Promise.resolve();
    }
    this.queue.push(structuredClone(job));
    if (!this.running) {
      const running = this.drain();
      this.running = running;
      void running.finally(() => { if (this.running === running) this.running = null; });
    }
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      if (job.epoch !== this.epoch()) continue;
      this.controller = new AbortController();
      const timer = setTimeout(() => this.controller?.abort('memory_timeout'), 25_000);
      try { await this.distill(job, this.controller.signal); }
      catch (error) {
        if (job.epoch === this.epoch()) this.emit({ subType: 'memory_status',
          code: error instanceof ResponsesError && error.status === 409 ? 'memory_conflict' : 'memory_failed' });
      } finally { clearTimeout(timer); this.controller = null; }
    }
  }

  private async distill(job: MemoryJob, signal: AbortSignal): Promise<void> {
    const expectedRevision = job.memory.revision ?? 0;
    const selected = selectServerMemory(job.memory, job.goal);
    // Existing credentials are not evidence for extracting new ones and must not reach this auxiliary call.
    const known = selected.knowledge.map(item => ({ key: item.key, category: item.category,
      source: item.source, value: item.category === 'credential' || isSensitiveKeyOrValue(item.key, item.value)
        ? '[REDACTED]' : boundedUtf8(redactEvidence(item.value), 256) }));
    const operations: Array<Record<string, unknown>> = [];
    for (const record of job.records) {
      if (record.role !== 'assistant') continue;
      for (const call of record.calls ?? []) {
        const result = job.records.find(item => item.role === 'tool' && item.callId === call.call_id);
        if (!result) continue; // A proposed call is NOT an executed operation.
        const parsed = parseObject(result.content);
        let description = call.name;
        try { description = String(JSON.parse(call.arguments).command ?? call.name); } catch { /* Already bounded evidence. */ }
        operations.push({ operation: boundedUtf8(redactEvidence(description), 128),
          status: parsed.status, executed: parsed.executed, exitCode: parsed.exit_code,
          evidence: boundedUtf8(redactEvidence(String(parsed.result ?? parsed.stdout ?? '')), 96) });
      }
    }
    // Keep EVERY middle operation's status; never head/tail-cut the entire JSON evidence.
    const input = JSON.stringify({ goal: boundedUtf8(job.goal, 8000), operations,
      conclusion: boundedUtf8(redactEvidence(job.records.at(-1)?.content ?? ''), 2000),
      existingWorkLogs: job.memory.workLogs.slice(0, 2), known,
      time: new Date().toISOString(), timezone: job.timezone, locale: job.locale });
    if (bytes(input) > 48 * 1024) throw new ResponsesError('responses_budget');
    const result = await new ResponsesClient(job.config).create({ stream: false,
      instructions: MEMORY_DISTILLATION_PROMPT + '\nPreserve actual status fields. Existing user-authored facts are protected. Never infer credentials from tool output. Prefer null workLog for trivial chat.',
      input: [observation('memory evidence', input)], max_output_tokens: 4096,
      text: { format: MEMORY_FORMAT } }, signal);
    console.info('Agent Responses auxiliary usage', { purpose: 'memory', input: result.usage?.input_tokens,
      output: result.usage?.output_tokens, cached: result.usage?.input_tokens_details?.cached_tokens,
      reasoning: result.usage?.output_tokens_details?.reasoning_tokens });
    signal.throwIfAborted();
    if (job.epoch !== this.epoch()) return;
    const parsed = parseObject(result.text);
    if (!Object.hasOwn(parsed, 'workLog') || !Array.isArray(parsed.knowledge) || parsed.knowledge.length > 100) {
      throw new ResponsesError('responses_schema');
    }
    const batch: AgentMemoryBatch = { expectedRevision,
      sessionId: job.sessionId, epoch: job.epoch, knowledge: [] };
    if (parsed.workLog != null) {
      if (typeof parsed.workLog !== 'object' || Array.isArray(parsed.workLog)) throw new ResponsesError('responses_schema');
      const log = normalizeWorkLogInput(parsed.workLog as Record<string, unknown>, { truncate: true });
      if (!log.ok) throw new ResponsesError('responses_schema');
      batch.workLog = log.value;
      if (this.lastLogId && job.memory.workLogs.some(item => item.id === this.lastLogId)) batch.targetLogId = this.lastLogId;
    }
    const unknown = operations.filter(op => op.status === 'unknown');
    if (unknown.length) {
      batch.workLog ??= { mode: 'create', title: job.goal.slice(0, 30), summary: '' };
      batch.workLog.summary = boundedText(`Unknown operations: ${unknown.length}. Inspect before retrying. ${unknown.map(op => String(op.operation)).join('; ')}`, 300);
    }
    if (job.interrupted && batch.workLog) {
      const prefix = job.locale === 'en-US' ? '[Interrupted] ' : job.locale === 'zh-TW' ? '[已中斷] ' : '[已中断] ';
      batch.workLog.title = `${prefix}${batch.workLog.title}`.slice(0, WORK_LOG_TITLE_MAX_LENGTH);
    }
    const successful = job.records.filter(record => record.role === 'tool' && record.status === 'succeeded').map(record => record.content).join('\n');
    for (const item of parsed.knowledge) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ResponsesError('responses_schema');
      const normalized = normalizeKnowledgeInput(item);
      if (!normalized.ok) throw new ResponsesError('responses_schema');
      const value = normalized.value;
      const sensitive = value.category === 'credential' || isSensitiveKeyOrValue(value.key, value.value);
      const existing = job.memory.knowledge.find(entry => entry.key === value.key);
      if (existing?.source === 'user' && !job.goal.toLowerCase().includes(value.key)) continue;
      if (value.action === 'delete') {
        if (!/delete|forget|remove|删除|移除|忘记|刪除|忘記/i.test(job.goal) || !job.goal.toLowerCase().includes(value.key)) continue;
      } else if (sensitive ? !job.goal.includes(value.value) : !job.goal.includes(value.value) && !successful.includes(value.value)) continue;
      batch.knowledge!.push(value);
    }
    if (batch.workLog || batch.knowledge!.length) {
      signal.throwIfAborted();
      if (job.epoch !== this.epoch()) return;
      await this.provider.saveBatchMemory(batch);
      if (job.epoch !== this.epoch()) return;
      const updated = await this.provider.fetchUnifiedMemory();
      if (job.epoch !== this.epoch()) return;
      if (batch.workLog) this.lastLogId = batch.targetLogId ?? updated.workLogs[0]?.id;
      this.emit({ subType: 'memory_updated' });
    }
  }
}
