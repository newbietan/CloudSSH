import { normalizeAIBaseUrl } from '../../ai-endpoint';
import { resolveAIModelBudgets, type AIModelBudgets } from '../../ai-model-policy';
import { normalizeResponseDiagnostics, type ResponseDiagnostics } from '../../agent-response-diagnostics';
import { providerError, retryAfterMs } from './responses-errors';
import { estimateTokens } from './context-limits';
import { validateBaseUrlWithDNS } from './ssrf';
import type { AIConfig, ModelResponse, ResponseFunctionCall, ResponseInput, ResponseOutput, ResponseUsage, ToolDefinition } from './types';

export class ResponsesError extends Error {
  constructor(public readonly code: string, public readonly status?: number,
    public diagnostics: ResponseDiagnostics = {}) {
    super(code);
    this.name = 'ResponsesError';
  }
}

export interface ResponseRequest {
  input: ResponseInput[];
  instructions: string;
  stream: boolean;
  tools?: ToolDefinition[];
  max_output_tokens: number;
  prompt_cache_key?: string;
  text?: { format: { type: 'json_schema'; name: string; strict: true; schema: Record<string, unknown> } };
  reasoning?: { effort: 'low' };
  allowIncomplete?: boolean;
  purpose?: 'main' | 'checkpoint' | 'memory';
}

const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_EVENT_CHARS = 1_000_000;
const MAX_CALLS = 24;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResponsesError('responses_invalid');
  return value as Record<string, unknown>;
}

function parseJSON(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    throw new ResponsesError('responses_invalid');
  }
}

function nativeId(item: Record<string, unknown>): { id?: string } {
  if (item.id == null) return {};
  if (typeof item.id !== 'string' || !item.id) throw new ResponsesError('responses_invalid');
  return { id: item.id }; // Never invent IDs that an upstream server did not issue.
}

function parseResponse(value: unknown, request: ResponseRequest): ModelResponse {
  const response = object(value);
  const isIncomplete = response.status === 'incomplete';
  if (response.status !== 'completed' && !isIncomplete) {
    throw new ResponsesError('responses_failed', undefined, providerError(response).diagnostics);
  }
  if (typeof response.id !== 'string' || !response.id || !Array.isArray(response.output)) {
    throw new ResponsesError('responses_invalid');
  }
  // Missing echoes are allowed; explicitly contradicting store:false is not.
  if (response.store === true) throw new ResponsesError('responses_storage');

  let incompleteReason: 'max_output_tokens' | 'content_filter' | 'unknown' | undefined;
  let incompleteDiagnostics: ResponseDiagnostics = {};
  if (isIncomplete) {
    const details = response.incomplete_details as Record<string, unknown> | null;
    incompleteReason = details?.reason === 'max_output_tokens' || details?.reason === 'content_filter'
      ? details.reason : 'unknown';
    const usage = response.usage as Record<string, unknown> | null;
    const outputDetails = usage?.output_tokens_details as Record<string, unknown> | null;
    incompleteDiagnostics = normalizeResponseDiagnostics({
      ...providerError(response).diagnostics, incompleteReason,
      parameter: incompleteReason === 'max_output_tokens' ? 'max_output_tokens' : undefined,
      requestedOutputTokens: request.max_output_tokens,
      outputTokens: usage?.output_tokens, reasoningTokens: outputDetails?.reasoning_tokens,
    });
    // Only an explicit token-limit stop can be recovered. Never resume filtering/unknown failures.
    if (!request.allowIncomplete || incompleteReason !== 'max_output_tokens') {
      throw new ResponsesError('responses_incomplete', undefined, incompleteDiagnostics);
    }
  }

  const output: ResponseOutput[] = [];
  let text = '';
  let refused = false;
  const calls: ResponseFunctionCall[] = [];
  const callIds = new Set<string>();
  for (const raw of response.output) {
    const item = object(raw);
    if (item.type === 'function_call') {
      if (isIncomplete || item.status === 'incomplete' || item.status === 'in_progress') {
        // Incomplete tool calls must NEVER be executed.
        if (!isIncomplete) throw new ResponsesError('responses_invalid');
        continue;
      }
      if (item.status != null && item.status !== 'completed') throw new ResponsesError('responses_invalid');
      const callId = typeof item.call_id === 'string' && item.call_id
        ? item.call_id
        : typeof item.callId === 'string' && item.callId
          ? item.callId
          : null;
      if (!callId || typeof item.name !== 'string' || !item.name ||
        typeof item.arguments !== 'string' || item.arguments.length > 64_000 || callIds.has(callId)) {
        throw new ResponsesError('responses_invalid');
      }
      callIds.add(callId);
      const call: ResponseFunctionCall = { type: 'function_call', ...nativeId(item), call_id: callId,
        name: item.name, arguments: item.arguments, status: 'completed' };
      calls.push(call);
      output.push(call);
      if (calls.length > MAX_CALLS) throw new ResponsesError('responses_invalid');
    } else if (item.type === 'message') {
      if ((item.status != null && item.status !== 'completed' &&
          (!isIncomplete || !['incomplete', 'in_progress'].includes(String(item.status)))) ||
        (item.role != null && item.role !== 'assistant') || !Array.isArray(item.content)) {
        throw new ResponsesError('responses_invalid');
      }
      if (item.phase != null && item.phase !== 'commentary' && item.phase !== 'final_answer') {
        throw new ResponsesError('responses_invalid');
      }
      const content: Extract<ResponseOutput, { type: 'message' }>['content'] = [];
      for (const rawPart of item.content) {
        const part = object(rawPart);
        if (part.type === 'output_text' && typeof part.text === 'string') {
          if (part.annotations != null && !Array.isArray(part.annotations)) throw new ResponsesError('responses_invalid');
          text += part.text;
          content.push({ type: 'output_text', text: part.text, annotations: part.annotations ?? [] });
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          refused = true;
          text += part.refusal;
          content.push({ type: 'refusal', refusal: part.refusal });
        } else throw new ResponsesError('responses_invalid');
      }
      output.push({ type: 'message', ...nativeId(item), role: 'assistant',
        status: item.status === 'incomplete' || item.status === 'in_progress' ? item.status : 'completed',
        ...(item.phase !== undefined ? { phase: item.phase as 'commentary' | 'final_answer' | null } : {}), content });
    } else if (item.type === 'reasoning') {
      const summary: Array<{ type: 'summary_text'; text: string }> = [];
      if (Array.isArray(item.summary)) {
        for (const raw of item.summary) {
          if (typeof raw === 'string') {
            summary.push({ type: 'summary_text', text: raw });
          } else if (raw && typeof raw === 'object' && typeof (raw as any).text === 'string') {
            summary.push({ type: 'summary_text', text: (raw as any).text });
          }
        }
      }
      const reasoning: Extract<ResponseOutput, { type: 'reasoning' }> = {
        type: 'reasoning', ...nativeId(item), summary,
      };
      if (item.encrypted_content !== undefined) {
        if (item.encrypted_content !== null && typeof item.encrypted_content !== 'string') {
          throw new ResponsesError('responses_invalid');
        }
        reasoning.encrypted_content = item.encrypted_content;
      }
      if (item.status != null) {
        if (!['completed', 'incomplete', 'in_progress'].includes(String(item.status))) {
          throw new ResponsesError('responses_invalid');
        }
        reasoning.status = item.status as NonNullable<typeof reasoning.status>;
      }
      if (item.content != null) {
        if (!Array.isArray(item.content)) throw new ResponsesError('responses_invalid');
        reasoning.content = item.content.map(raw => {
          const part = object(raw);
          if (part.type !== 'reasoning_text' || typeof part.text !== 'string') {
            throw new ResponsesError('responses_invalid');
          }
          return { type: 'reasoning_text', text: part.text };
        });
      }
      output.push(reasoning);
    } else {
      // Hosted tools and implicit protocol downgrades are not part of CloudSSH's execution boundary.
      throw new ResponsesError('responses_invalid');
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new ResponsesError('responses_invalid');
  }

  if (isIncomplete && !text.trim() && !(incompleteReason === 'max_output_tokens' &&
    output.some(item => item.type === 'reasoning' && item.encrypted_content))) {
    throw new ResponsesError('responses_incomplete', undefined, incompleteDiagnostics);
  }

  if (calls.length && (!request.tools || refused)) throw new ResponsesError('responses_invalid');
  let usage: ResponseUsage | undefined;
  if (response.usage != null) {
    try {
      const raw = object(response.usage);
      const toTokens = (val: unknown): number => {
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) return Math.round(val);
        return 0;
      };
      const inputTokens = toTokens(raw.input_tokens);
      const outputTokens = toTokens(raw.output_tokens);
      const totalTokens = toTokens(raw.total_tokens) || (inputTokens + outputTokens);
      const inputDetails = raw.input_tokens_details == null ? {} : object(raw.input_tokens_details);
      const outputDetails = raw.output_tokens_details == null ? {} : object(raw.output_tokens_details);
      usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        input_tokens_details: { cached_tokens: toTokens(inputDetails.cached_tokens) },
        output_tokens_details: { reasoning_tokens: toTokens(outputDetails.reasoning_tokens) },
      };
    } catch {
      /* Usage 是非业务阻断元数据，遇到异常结构时忽略或降级，绝不击穿主任务 */
    }
  }
    return {
      id: response.id,
      text,
      calls,
      output,
      usage,
      status: isIncomplete ? 'incomplete' : 'completed',
      incompleteReason,
    };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readJsonBody(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ResponsesError('responses_invalid');
  const decoder = new TextDecoder();
  let json = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      json += decoder.decode(value, { stream: true });
      if (json.length > limit) throw new ResponsesError('responses_invalid');
    }
    json += decoder.decode();
    return parseJSON(json);
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ResponsesClient {
  readonly baseUrl: string;
  private unsupported = new Set<string>();
  private budgets: AIModelBudgets;

  constructor(private readonly config: AIConfig) {
    try {
      this.baseUrl = normalizeAIBaseUrl(config.base_url);
    } catch {
      throw new ResponsesError('responses_address');
    }
    try { this.budgets = resolveAIModelBudgets(config); }
    catch { throw new ResponsesError('responses_limits'); }
  }

  private payload(request: ResponseRequest): Record<string, unknown> {
    if (!Number.isInteger(request.max_output_tokens) || request.max_output_tokens < 1) {
      throw new ResponsesError('responses_limits');
    }
    // Explicit allowlist: storage/chaining overrides can never be smuggled by a caller.
    const payload: Record<string, unknown> = {
      model: this.config.model, store: false, input: request.input,
      instructions: request.instructions, stream: request.stream,
      max_output_tokens: Math.min(request.max_output_tokens, this.budgets.max_output_tokens),
    };
    if (!this.unsupported.has('truncation')) payload.truncation = 'disabled'; // API default is disabled.
    if (!this.unsupported.has('include')) payload.include = ['reasoning.encrypted_content'];
    if (request.prompt_cache_key && !this.unsupported.has('prompt_cache_key')) {
      payload.prompt_cache_key = request.prompt_cache_key;
    }
    if (request.text) {
      if (this.unsupported.has('text.format')) {
        // Still validated locally by checkpoint/memory code; never switch to Chat Completions.
        payload.instructions += '\nReturn only one JSON object matching this JSON Schema, without Markdown:\n' +
          JSON.stringify(request.text.format.schema);
      } else payload.text = request.text;
    }
    if (request.reasoning?.effort === 'low' && !this.unsupported.has('reasoning') &&
      !this.unsupported.has('reasoning.effort')) payload.reasoning = { effort: 'low' };
    if (request.tools) {
      payload.tools = request.tools.map(tool => ({ ...tool,
        strict: this.unsupported.has('tools.strict') ? false : tool.strict }));
      if (!this.unsupported.has('tool_choice')) payload.tool_choice = 'auto';
      // Tool execution remains sequential and locally validated even if the model returns a batch.
      if (!this.unsupported.has('parallel_tool_calls')) payload.parallel_tool_calls = false;
    }
    return payload;
  }

  private canOmit(parameter: string, payload: Record<string, unknown>): boolean {
    if (this.unsupported.has(parameter)) return false;
    if (parameter === 'tools.strict') return Boolean(payload.tools);
    if (parameter === 'text.format') return Boolean(payload.text);
    if (parameter === 'reasoning' || parameter === 'reasoning.effort') return Boolean(payload.reasoning);
    return ['prompt_cache_key', 'truncation', 'parallel_tool_calls', 'tool_choice', 'include'].includes(parameter) &&
      Object.hasOwn(payload, parameter);
  }

  private withinBudget(payload: Record<string, unknown>): boolean {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    const estimatedInputTokens = estimateTokens(payload);
    return bodyBytes <= 2 * 1024 * 1024 &&
      estimatedInputTokens + Number(payload.max_output_tokens) + 512 < this.budgets.context_window;
  }

  /** Same serialized-body budget used by create(), for atomic checkpoint preflight. */
  canFit(request: ResponseRequest): boolean { return this.withinBudget(this.payload(request)); }

  async create(request: ResponseRequest, signal: AbortSignal, onText?: (delta: string) => void): Promise<ModelResponse> {
    let requestId = crypto.randomUUID();
    let stage: ResponseDiagnostics['stage'] = 'http';
    try {
      signal.throwIfAborted();
      const address = await validateBaseUrlWithDNS(this.baseUrl);
      signal.throwIfAborted();
      if (!address.valid) throw new ResponsesError('responses_address');
      let transientRetries = 0;
      let compatibilityRetries = 0;
      for (;;) {
        signal.throwIfAborted();
        stage = 'http';
        const payload = this.payload(request);
        const body = JSON.stringify(payload);
        // UTF-8 bytes are a conservative estimate, not a model-specific tokenizer.
        if (!this.withinBudget(payload)) {
          throw new ResponsesError('responses_budget');
        }
        const response = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST', redirect: 'manual', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.api_key}`,
            'Idempotency-Key': requestId }, body,
        });
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel();
          throw new ResponsesError('responses_redirect');
        }
        if (!response.ok) {
          if (transientRetries < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
            void response.body?.cancel();
            const backoff = retryAfterMs(response.headers.get('Retry-After')) ?? 1000 * (transientRetries + 1);
            transientRetries++;
            await delay(backoff, signal);
            continue; // Identical body, same idempotency key.
          }
          let errorBody: unknown;
          try {
            errorBody = await readJsonBody(response,
              AbortSignal.any([signal, AbortSignal.timeout(2000)]), 32_768);
          } catch {
            signal.throwIfAborted(); // Non-JSON, oversized or stalled error bodies are never surfaced.
          }
          const failure = providerError(errorBody);
          if ([400, 422].includes(response.status) && failure.unsupported && compatibilityRetries < 6 &&
            this.canOmit(failure.unsupported, payload)) {
            this.unsupported.add(failure.unsupported);
            compatibilityRetries++;
            requestId = crypto.randomUUID(); // Changed body MUST NOT reuse an idempotency key.
            continue;
          }
          throw new ResponsesError('responses_http', response.status, failure.diagnostics);
        }
        const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
        stage = request.stream && mime !== 'application/json' && !mime?.endsWith('+json') ? 'stream' : 'parse';
        // A gateway may return a complete JSON response despite stream:true. Same completion checks apply.
        const effectiveRequest = { ...request, max_output_tokens: Number(payload.max_output_tokens) };
        const result = stage === 'stream'
          ? await this.readStream(response, effectiveRequest, signal, onText)
          : parseResponse(await readJsonBody(response, signal, MAX_RESPONSE_CHARS), effectiveRequest);
        return { ...result, requestId };
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const failure = error instanceof ResponsesError ? error : new ResponsesError('responses_failed');
      failure.diagnostics = normalizeResponseDiagnostics({ ...failure.diagnostics,
        requestId, stage, purpose: request.purpose ?? 'main' });
      throw failure;
    }
  }

  private async readStream(response: Response, request: ResponseRequest, signal: AbortSignal,
    onText?: (delta: string) => void): Promise<ModelResponse> {
    const reader = response.body?.getReader();
    if (!reader || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
      throw new ResponsesError('responses_invalid');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedChars = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > MAX_EVENT_CHARS) throw new ResponsesError('responses_invalid');
        // SSE frames may span TCP chunks and use LF, CRLF, or CR line endings.
        for (;;) {
          const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
          if (!boundary) break;
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue; // SSE comments/heartbeats
          if (data.trim() === '[DONE]') continue; // 行业标准：终结帧安全跳过，绝不交给 JSON.parse
          let event: Record<string, unknown>;
          try {
            event = object(parseJSON(data));
          } catch {
            continue; // 忽略非 JSON 数据（如代理心跳或注释），保证流平稳消费
          }
          if (event.type === 'response.output_text.delta') {
            if (typeof event.delta !== 'string') throw new ResponsesError('responses_invalid');
            streamedChars += event.delta.length;
            if (streamedChars > MAX_RESPONSE_CHARS) throw new ResponsesError('responses_invalid');
            onText?.(event.delta);
          } else if (event.type === 'response.completed') {
            return parseResponse(event.response, request);
          } else if (event.type === 'response.incomplete') {
            if (request.allowIncomplete && event.response && typeof event.response === 'object') {
              const respObj = { ...(event.response as Record<string, unknown>), status: 'incomplete' };
              return parseResponse(respObj, request);
            }
            throw new ResponsesError('responses_incomplete');
          } else if (event.type === 'response.failed' || event.type === 'error') {
            throw new ResponsesError('responses_failed', undefined,
              providerError(event.response ?? event).diagnostics);
          }
          // 对于心跳包（ping/keep-alive）或网关自定义辅助事件，静默忽略，绝不抛错阻断业务
          // Arguments are assembled only from completed output, never executed from deltas.
          // Reasoning items are retained only from completed output, never displayed or logged as text.
        }
        if (done) throw new ResponsesError('responses_stream'); // EOF is not successful completion.
      }
    } finally {
      signal.removeEventListener('abort', abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
