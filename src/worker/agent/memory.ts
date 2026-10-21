import { isSensitiveKeyOrValue, normalizeKnowledgeInput, VALID_KNOWLEDGE_CATEGORIES,
  type UnifiedServerMemory } from '../../server-memory-schema';
import { resolveAIModelBudgets } from '../../ai-model-policy';
import { boundedUtf8, bytes } from './context-limits';
import { observation } from './context';
import { redactEvidence } from './execution-journal';
import { MEMORY_DISTILLATION_PROMPT, MEMORY_FORMAT, type AgentLocale } from './prompt';
import { ResponsesClient, ResponsesError } from './responses-client';
import type { AgentMemoryBatch, AgentMemoryProvider, AIConfig, TaskRecord } from './types';

type Knowledge = Extract<ReturnType<typeof normalizeKnowledgeInput>, { ok: true }>['value'];

/** Deterministic, bounded retrieval; secrets match names, never their secret values. */
export function selectServerMemory(memory: UnifiedServerMemory, goal: string): UnifiedServerMemory {
  const query = goal.toLowerCase();
  const words = new Set(query.match(/[\p{L}\p{N}_./-]{2,}/gu) ?? []);
  for (const [pattern, aliases] of [
    [/端口|連接埠|埠號/u, ['port']], [/路径|路徑/u, ['path']], [/密码|密碼/u, ['password']],
    [/令牌|金鑰|密钥/u, ['token', 'key']], [/数据库|資料庫/u, ['database', 'db']],
  ] as const) if (pattern.test(query)) for (const alias of aliases) words.add(alias);
  for (let i = 0; i < query.length - 1; i++) {
    const pair = query.slice(i, i + 2);
    if (/^[\p{Script=Han}]{2}$/u.test(pair)) words.add(pair);
  }
  const score = (key: string, value: string) => {
    const name = key.toLowerCase();
    let rank = query.includes(name) ? 20 : 0;
    for (const token of name.split(/[_\s-]+/).filter(word => word.length > 1)) if (query.includes(token)) rank += 4;
    for (const word of words) if (name.includes(word) || value.toLowerCase().includes(word)) rank++;
    return rank;
  };
  const now = Date.now();
  const knowledge = memory.knowledge.filter(item => !item.stale && (item.expires_at == null || item.expires_at > now))
    .map(item => ({ item, score: score(item.key, item.category === 'credential' || isSensitiveKeyOrValue(item.key, item.value) ? '' : item.value) }));
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
  /** Legacy caller snapshot; deliberately NOT retained in the queue or used for writes. */
  memory: UnifiedServerMemory;
  goal: string;
  config: AIConfig;
  locale: AgentLocale;
  timezone: string;
  interrupted: boolean;
  iteration: number;
  epoch: number;
  sessionId: string;
  taskId?: string;
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

function parseDistillation(text: string): Knowledge[] {
  const parsed = parseObject(text);
  if (!Array.isArray(parsed.knowledge) || parsed.knowledge.length > 100 || Object.keys(parsed).some(key => key !== 'knowledge')) {
    throw new ResponsesError('responses_schema');
  }
  const unique = new Map<string, Knowledge>();
  for (const item of parsed.knowledge) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      !['set', 'delete'].includes(item.action) || !VALID_KNOWLEDGE_CATEGORIES.includes(item.category) ||
      (item.action === 'delete' && item.value !== null) ||
      Object.keys(item).some(key => !['action', 'category', 'key', 'value'].includes(key))) throw new ResponsesError('responses_schema');
    const normalized = normalizeKnowledgeInput(item);
    if (!normalized.ok) throw new ResponsesError('responses_schema');
    const old = unique.get(normalized.value.key);
    if (old && JSON.stringify(old) !== JSON.stringify(normalized.value)) throw new ResponsesError('responses_schema');
    unique.set(normalized.value.key, normalized.value);
  }
  return [...unique.values()];
}

/** Race even storage adapters that cannot cancel their underlying work; callers recheck epochs before writes. */
function boundedAwait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ResponsesError('responses_timeout', undefined, { purpose: 'memory' }));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export class AgentMemoryManager {
  private queue: MemoryJob[] = [];
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private client?: ResponsesClient;
  private clientConfig = '';

  constructor(private provider: AgentMemoryProvider, private epoch: () => number,
    private emit: (frame: Record<string, unknown>) => void,
    private onUpdated?: (memory: UnifiedServerMemory) => void) {}

  reset(): void {
    this.queue = [];
    this.controller?.abort('reset');
    this.client = undefined;
    this.clientConfig = '';
  }

  enqueue(job: MemoryJob): Promise<void> {
    // No queued copy of the whole credential store. Each job reads a fresh revision at execution time.
    const queued = { ...job, memory: { workLogs: [], knowledge: [] } };
    if (bytes(queued) > MAX_JOB_BYTES || this.queue.length >= 4 || bytes([...this.queue, queued]) > MAX_QUEUE_BYTES) {
      this.emit({ subType: 'memory_status', code: 'memory_busy' });
      return Promise.resolve();
    }
    this.queue.push(structuredClone(queued));
    if (!this.running) this.running = this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    // Ensure enqueue has assigned running, including when every queued job has a stale epoch.
    await Promise.resolve();
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        if (job.epoch !== this.epoch()) continue;
        const controller = new AbortController();
        this.controller = controller;
        const timer = setTimeout(() => controller.abort('memory_timeout'), 25_000);
        try { await this.distill(job, controller.signal); }
        catch (error) {
          if (job.epoch === this.epoch() && controller.signal.reason !== 'reset') {
            const failure = controller.signal.aborted ? new ResponsesError('responses_timeout')
              : error instanceof ResponsesError ? error : new ResponsesError('responses_failed');
            this.emit({ subType: 'memory_status', code: failure.code === 'responses_memory_conflict' ? 'memory_conflict' : 'memory_failed',
              errorCode: failure.code, status: failure.status, diagnostics: { purpose: 'memory', ...failure.diagnostics } });
          }
        } finally { clearTimeout(timer); this.controller = null; }
      }
    } finally { this.running = null; }
  }

  private async distill(job: MemoryJob, signal: AbortSignal): Promise<void> {
    const configKey = JSON.stringify(job.config); // Private per-manager binding, NEVER a log/cache key sent upstream.
    if (!this.client || this.clientConfig !== configKey) {
      this.client = new ResponsesClient(job.config);
      this.clientConfig = configKey;
    }
    const client = this.client;
    const budgets = resolveAIModelBudgets(job.config);
    const operations: Array<Record<string, unknown>> = [];
    for (const record of job.records) {
      if (record.role !== 'assistant') continue;
      for (const call of record.calls ?? []) {
        const result = job.records.find(item => item.role === 'tool' && item.callId === call.call_id);
        if (!result) continue;
        const parsed = parseObject(result.content);
        let description = call.name;
        try { description = String(JSON.parse(call.arguments).command ?? call.name); } catch { /* Bounded evidence. */ }
        operations.push({ callId: call.call_id, operation: boundedUtf8(redactEvidence(description), 128),
          status: parsed.status, executed: parsed.executed, exitCode: parsed.exit_code,
          evidence: boundedUtf8(redactEvidence(String(parsed.result ?? parsed.stdout ?? '')), 96) });
      }
    }
    const time = new Date().toISOString();
    // At most TWO generations total, shared by schema/token-limit repair OR a fresh revision-conflict recomputation.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      if (job.epoch !== this.epoch()) return;
      const memory = await boundedAwait(this.provider.fetchUnifiedMemory(signal), signal);
      signal.throwIfAborted();
      if (job.epoch !== this.epoch()) return;
      if (!Number.isSafeInteger(memory.revision) || memory.revision! < 0) throw new ResponsesError('responses_memory_storage');
      const known = selectServerMemory(memory, job.goal).knowledge.map(item => ({ key: item.key, category: item.category,
        source: item.source, value: item.category === 'credential' || isSensitiveKeyOrValue(item.key, item.value)
          ? '[REDACTED]' : boundedUtf8(redactEvidence(item.value), 256) }));
      const input = JSON.stringify({ goal: job.goal, operations,
        conclusion: boundedUtf8(redactEvidence(job.records.at(-1)?.content ?? ''), attempt ? 800 : 2000), known,
        time, timezone: job.timezone, locale: job.locale });
      if (bytes(input) > 48 * 1024) throw new ResponsesError('responses_budget');
      const instructions = MEMORY_DISTILLATION_PROMPT + '\nReturn only one JSON object matching this JSON Schema:\n' +
        JSON.stringify(MEMORY_FORMAT.schema) + (attempt ? '\nThe previous attempt did not produce an accepted memory update (failed local validation, output limit or revision conflict). Regenerate from this fresh evidence, not previous output. Use short atomic facts, every required field, no Markdown.' : '');
      let knowledge: Knowledge[];
      try {
        const result = await client.create({ purpose: 'memory', stream: false, instructions,
          input: [observation('memory evidence', input)],
          max_output_tokens: Math.min(budgets.max_output_tokens, attempt ? 16_384 : 8192),
          reasoning: { effort: 'low' }, text: { format: MEMORY_FORMAT } }, signal);
        console.info('Agent Responses auxiliary usage', { purpose: 'memory', input: result.usage?.input_tokens,
          output: result.usage?.output_tokens, cached: result.usage?.input_tokens_details?.cached_tokens,
          reasoning: result.usage?.output_tokens_details?.reasoning_tokens });
        signal.throwIfAborted();
        if (job.epoch !== this.epoch()) return;
        try { knowledge = parseDistillation(result.text); }
        catch (error) {
          if (error instanceof ResponsesError) error.diagnostics = { purpose: 'memory', stage: 'parse', parameter: 'text.format', requestId: result.requestId };
          throw error;
        }
      } catch (error) {
        if (!attempt && error instanceof ResponsesError && (error.code === 'responses_schema' ||
          (error.code === 'responses_incomplete' && error.diagnostics.incompleteReason === 'max_output_tokens'))) continue;
        throw error;
      }
      const batch: AgentMemoryBatch = { expectedRevision: memory.revision!, sessionId: job.sessionId,
        epoch: job.epoch, taskId: job.taskId, knowledge: [] };
      for (const value of knowledge) {
        const existing = memory.knowledge.find(item => item.key === value.key);
        const namesKey = job.goal.toLowerCase().includes(value.key.toLowerCase());
        if (value.action === 'delete') {
          if (existing && namesKey && /delete|forget|remove|删除|移除|忘记|刪除|忘記/i.test(job.goal)) {
            batch.knowledge!.push({ ...value, evidence: ['user'] });
          }
          continue;
        }
        if (existing?.source === 'user' && !(namesKey && job.goal.includes(value.value) &&
          /set|change|update|replace|remember|设置|设为|改为|更新|记住|設定|設為|改為|記住/i.test(job.goal))) continue;
        const sensitive = value.category === 'credential' || isSensitiveKeyOrValue(value.key, value.value);
        const evidence = job.goal.includes(value.value) ? ['user'] : sensitive ? [] : job.records.filter(record =>
          record.role === 'tool' && record.status === 'succeeded' && record.content.includes(value.value))
          .map(record => record.callId!).filter(Boolean);
        if (!evidence.length) continue;
        if (existing && !existing.stale && (existing.expires_at == null || existing.expires_at > Date.now()) &&
          existing.value === value.value && existing.category === value.category) continue;
        batch.knowledge!.push({ ...value, evidence: [...new Set(evidence)] });
      }
      if (!batch.knowledge!.length) return;
      signal.throwIfAborted();
      if (job.epoch !== this.epoch()) return;
      try { await boundedAwait(this.provider.saveBatchMemory(batch, signal), signal); }
      catch (error) {
        if (!attempt && error instanceof ResponsesError && error.code === 'responses_memory_conflict') continue;
        throw error;
      }
      signal.throwIfAborted();
      if (job.epoch !== this.epoch()) return;
      const updated = await boundedAwait(this.provider.fetchUnifiedMemory(signal), signal);
      signal.throwIfAborted();
      if (job.epoch !== this.epoch()) return;
      this.onUpdated?.(updated);
      this.emit({ subType: 'memory_updated' });
      return;
    }
  }
}
