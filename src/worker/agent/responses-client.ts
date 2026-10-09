import { normalizeAIBaseUrl } from '../../ai-endpoint';
import { validateBaseUrlWithDNS } from './ssrf';
import type { AIConfig, ModelResponse, ResponseFunctionCall, ResponseInput, ResponseOutput, ResponseUsage, ToolDefinition } from './types';

export class ResponsesError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(code);
    this.name = 'ResponsesError';
  }
}

interface ResponseRequest {
  input: ResponseInput[];
  instructions: string;
  stream: boolean;
  tools?: ToolDefinition[];
  max_output_tokens: number;
  prompt_cache_key?: string;
  text?: { format: { type: 'json_schema'; name: string; strict: true; schema: Record<string, unknown> } };
  allowIncomplete?: boolean;
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

function parseResponse(value: unknown, request: ResponseRequest): ModelResponse {
  const response = object(value);
  const isIncomplete = response.status === 'incomplete';
  if (response.status !== 'completed' && (!isIncomplete || !request.allowIncomplete)) {
    throw new ResponsesError(isIncomplete ? 'responses_incomplete' : 'responses_failed');
  }
  if (typeof response.id !== 'string' || !response.id || !Array.isArray(response.output)) {
    throw new ResponsesError('responses_invalid');
  }
  // Missing echoes are allowed; explicitly contradicting store:false is not.
  if (response.store === true) throw new ResponsesError('responses_storage');

  let incompleteReason: string | undefined;
  if (isIncomplete) {
    if (response.incomplete_details && typeof response.incomplete_details === 'object') {
      const details = response.incomplete_details as Record<string, unknown>;
      if (typeof details.reason === 'string') {
        incompleteReason = details.reason;
        if (incompleteReason === 'content_filter') {
          throw new ResponsesError('responses_incomplete');
        }
      }
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
      const callId = typeof item.call_id === 'string' && item.call_id
        ? item.call_id
        : typeof item.callId === 'string' && item.callId
          ? item.callId
          : typeof item.id === 'string' && item.id
            ? item.id
            : null;
      const itemId = typeof item.id === 'string' && item.id ? item.id : callId;
      if (!callId || !itemId || typeof item.name !== 'string' || !item.name ||
        typeof item.arguments !== 'string' || item.arguments.length > 64_000 || callIds.has(callId)) {
        throw new ResponsesError('responses_invalid');
      }
      callIds.add(callId);
      const call: ResponseFunctionCall = { type: 'function_call', id: itemId, call_id: callId,
        name: item.name, arguments: item.arguments, status: 'completed' };
      calls.push(call);
      output.push(call);
      if (calls.length > MAX_CALLS) throw new ResponsesError('responses_invalid');
    } else if (item.type === 'message') {
      if ((!isIncomplete && (item.status === 'incomplete' || item.status === 'in_progress')) ||
        (item.role != null && item.role !== 'assistant') || !Array.isArray(item.content)) {
        throw new ResponsesError('responses_invalid');
      }
      const itemId = typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID();
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
      output.push({ type: 'message', id: itemId, role: 'assistant', status: 'completed', content });
    } else if (item.type === 'reasoning') {
      const itemId = typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID();
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
      output.push({ type: 'reasoning', id: itemId, summary });
    } else {
      // Hosted tools and implicit protocol downgrades are not part of CloudSSH's execution boundary.
      throw new ResponsesError('responses_invalid');
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new ResponsesError('responses_invalid');
  }

  if (isIncomplete && !text.trim()) {
    throw new ResponsesError('responses_incomplete');
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

  constructor(private readonly config: AIConfig) {
    try {
      this.baseUrl = normalizeAIBaseUrl(config.base_url);
    } catch {
      throw new ResponsesError('responses_address');
    }
  }

  async create(request: ResponseRequest, signal: AbortSignal, onText?: (delta: string) => void): Promise<ModelResponse> {
    signal.throwIfAborted();
    const address = await validateBaseUrlWithDNS(this.baseUrl);
    signal.throwIfAborted();
    if (!address.valid) throw new ResponsesError('responses_address');
    // Build the wire body explicitly: no caller can smuggle storage/chaining parameters.
    const payload: Record<string, unknown> = {
      model: this.config.model,
      store: false,
      truncation: 'disabled',
      input: request.input,
      instructions: request.instructions,
      stream: request.stream,
      max_output_tokens: request.max_output_tokens,
    };
    if (request.prompt_cache_key) payload.prompt_cache_key = request.prompt_cache_key;
    if (request.text) payload.text = request.text;
    if (request.tools) {
      payload.tools = request.tools;
      payload.tool_choice = 'auto';
      payload.parallel_tool_calls = false;
    }
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > 2 * 1024 * 1024) throw new ResponsesError('responses_budget');
    const requestId = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST', redirect: 'manual', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.api_key}`, 'Idempotency-Key': requestId },
        body,
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel();
        throw new ResponsesError('responses_redirect');
      }
      if (!response.ok) {
        if (attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
          void response.body?.cancel();
          await delay(1000 * (attempt + 1), signal);
          continue;
        }
        void response.body?.cancel();
        // Never expose provider error bodies, tokens or URLs.
        throw new ResponsesError('responses_http', response.status);
      }
      // Never retry a stream after output has started. In particular, never replay SSH side effects.
      if (request.stream) return this.readStream(response, request, signal, onText);
      return parseResponse(await readJsonBody(response, signal, MAX_RESPONSE_CHARS), request);
    }
  }

  private async readStream(response: Response, request: ResponseRequest, signal: AbortSignal,
    onText?: (delta: string) => void): Promise<ModelResponse> {
    const reader = response.body?.getReader();
    if (!reader || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
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
            throw new ResponsesError('responses_failed');
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
