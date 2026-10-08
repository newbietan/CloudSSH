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
  if (response.status !== 'completed') {
    throw new ResponsesError(response.status === 'incomplete' ? 'responses_incomplete' : 'responses_failed');
  }
  if (typeof response.id !== 'string' || !response.id || !Array.isArray(response.output)) {
    throw new ResponsesError('responses_invalid');
  }
  // Missing echoes are allowed; explicitly contradicting store:false is not.
  if (response.store === true) throw new ResponsesError('responses_storage');
  const output: ResponseOutput[] = [];
  let text = '';
  let refused = false;
  const calls: ResponseFunctionCall[] = [];
  const callIds = new Set<string>();
  for (const raw of response.output) {
    const item = object(raw);
    if (item.type === 'function_call') {
      if (item.status !== 'completed' || typeof item.id !== 'string' || !item.id ||
        typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name ||
        typeof item.arguments !== 'string' || item.arguments.length > 64_000 || callIds.has(item.call_id)) {
        throw new ResponsesError('responses_invalid');
      }
      callIds.add(item.call_id);
      const call: ResponseFunctionCall = { type: 'function_call', id: item.id, call_id: item.call_id,
        name: item.name, arguments: item.arguments, status: 'completed' };
      calls.push(call);
      output.push(call);
      if (calls.length > MAX_CALLS) throw new ResponsesError('responses_invalid');
    } else if (item.type === 'message') {
      if (item.status !== 'completed' || item.role !== 'assistant' || typeof item.id !== 'string' ||
        !item.id || !Array.isArray(item.content)) {
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
      output.push({ type: 'message', id: item.id, role: 'assistant', status: 'completed', content });
    } else if (item.type === 'reasoning') {
      if (typeof item.id !== 'string' || !item.id || !Array.isArray(item.summary)) throw new ResponsesError('responses_invalid');
      const summary = item.summary.map(raw => {
        const part = object(raw);
        if (part.type !== 'summary_text' || typeof part.text !== 'string') throw new ResponsesError('responses_invalid');
        return { type: 'summary_text' as const, text: part.text };
      });
      if (item.encrypted_content != null && (typeof item.encrypted_content !== 'string' || !item.encrypted_content)) {
        throw new ResponsesError('responses_invalid');
      }
      if (request.tools && !item.encrypted_content) throw new ResponsesError('responses_reasoning');
      output.push({ type: 'reasoning', id: item.id, summary,
        ...(item.encrypted_content ? { encrypted_content: item.encrypted_content as string } : {}) });
    } else {
      // Hosted tools and implicit protocol downgrades are not part of CloudSSH's execution boundary.
      throw new ResponsesError('responses_invalid');
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new ResponsesError('responses_invalid');
  }
  if (calls.length && (!request.tools || refused)) throw new ResponsesError('responses_invalid');
  let usage: ResponseUsage | undefined;
  if (response.usage != null) {
    const raw = object(response.usage);
    for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
      if (typeof raw[field] !== 'number' || !Number.isSafeInteger(raw[field]) || (raw[field] as number) < 0) {
        throw new ResponsesError('responses_invalid');
      }
    }
    const inputDetails = raw.input_tokens_details == null ? {} : object(raw.input_tokens_details);
    const outputDetails = raw.output_tokens_details == null ? {} : object(raw.output_tokens_details);
    const counter = (value: unknown): number => {
      if (value == null) return 0;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ResponsesError('responses_invalid');
      return value;
    };
    usage = { input_tokens: counter(raw.input_tokens), output_tokens: counter(raw.output_tokens),
      total_tokens: counter(raw.total_tokens),
      input_tokens_details: { cached_tokens: counter(inputDetails.cached_tokens) },
      output_tokens_details: { reasoning_tokens: counter(outputDetails.reasoning_tokens) } };
    if ((usage.input_tokens_details?.cached_tokens || 0) > usage.input_tokens ||
      (usage.output_tokens_details?.reasoning_tokens || 0) > usage.output_tokens) throw new ResponsesError('responses_invalid');
  }
  return { id: response.id, text, calls, output, usage };
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
    const body = JSON.stringify({ model: this.config.model, store: false, truncation: 'disabled',
      input: request.input, instructions: request.instructions, stream: request.stream,
      max_output_tokens: request.max_output_tokens,
      ...(request.prompt_cache_key ? { prompt_cache_key: request.prompt_cache_key } : {}),
      ...(request.text ? { text: request.text } : {}),
      ...(request.tools ? { tools: request.tools, tool_choice: 'auto', parallel_tool_calls: false,
        include: ['reasoning.encrypted_content'] } : {}) });
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
          const event = object(parseJSON(data));
          if (event.type === 'response.output_text.delta') {
            if (typeof event.delta !== 'string') throw new ResponsesError('responses_invalid');
            streamedChars += event.delta.length;
            if (streamedChars > MAX_RESPONSE_CHARS) throw new ResponsesError('responses_invalid');
            onText?.(event.delta);
          } else if (event.type === 'response.completed') {
            return parseResponse(event.response, request);
          } else if (event.type === 'response.incomplete') {
            throw new ResponsesError('responses_incomplete');
          } else if (event.type === 'response.failed' || event.type === 'error') {
            throw new ResponsesError('responses_failed');
          } else if (typeof event.type !== 'string' || !event.type.startsWith('response.')) {
            throw new ResponsesError('responses_invalid');
          }
          // Arguments are assembled only from completed output, never executed from deltas.
          // Opaque reasoning is retained only from completed output, never displayed or logged.
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
