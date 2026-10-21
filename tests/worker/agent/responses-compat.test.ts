import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesClient } from '../../../src/worker/agent/responses-client';
import { retryAfterMs } from '../../../src/worker/agent/responses-errors';
import { AGENT_TOOLS } from '../../../src/worker/agent/tools';
import { MEMORY_FORMAT } from '../../../src/worker/agent/prompt';
import { distillMemory } from '../../../src/worker/agent/memory';
import { aiConfig, functionCall, responseObject, sse } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
const request = { input: [{ role: 'user' as const, content: 'Inspect' }], instructions: 'Stable instructions',
  stream: true, tools: AGENT_TOOLS, max_output_tokens: 8192, prompt_cache_key: 'cache-example' };
const signal = () => new AbortController().signal;
const complete = () => sse([{ type: 'response.completed', response: responseObject('resp_done') }]);
const unsupported = (param: string, message = `Unsupported parameter: ${param}`) =>
  new Response(JSON.stringify({ error: { code: 'unsupported_parameter', param, message } }), { status: 400 });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Native stateless Responses compatibility', () => {
  it('preserves standard opaque reasoning, content, status and assistant phase without exposing reasoning', async () => {
    const body: any = responseObject('resp_native', 'Visible only');
    body.output[0].phase = 'final_answer';
    body.output.unshift({ type: 'reasoning', id: 'rs_native', summary: [], status: 'completed',
      encrypted_content: 'OPAQUE_REASONING', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    const text = vi.fn();
    const result = await new ResponsesClient(aiConfig).create(request, signal(), text);
    expect(result.output).toEqual(body.output);
    expect(result.text).toBe('Visible only');
    expect(text).not.toHaveBeenCalled();
  });

  it('does not fabricate item IDs, but keeps an explicit callId alias for compatible gateways', async () => {
    const body: any = responseObject('resp_no_item_ids', 'Done');
    delete body.output[0].id;
    body.output.unshift({ type: 'reasoning', summary: [], encrypted_content: 'opaque' },
      { type: 'function_call', callId: 'actual-call', name: 'list_processes', arguments: '{}' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    const result = await new ResponsesClient(aiConfig).create(request, signal());
    expect(result.output.every(item => !('id' in item))).toBe(true);
    expect(result.calls[0].call_id).toBe('actual-call');
  });

  it.each([
    { ...functionCall(), call_id: undefined },
    { ...functionCall(), status: 'failed' },
    { type: 'reasoning', id: 'rs_bad', summary: [], encrypted_content: { unsafe: true } },
  ])('rejects ambiguous calls or malformed native fields: %j', async item => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed',
      response: responseObject('resp_bad', '', [item as any]) }]));
    await expect(new ResponsesClient(aiConfig).create(request, signal())).rejects.toMatchObject({ code: 'responses_invalid' });
  });

  it('permits bounded continuation of opaque reasoning at the token limit, without executing partial calls', async () => {
    const body: any = responseObject('resp_limit', '', [functionCall()]);
    body.status = 'incomplete';
    body.incomplete_details = { reason: 'max_output_tokens' };
    body.output.unshift({ type: 'reasoning', id: 'rs_limit', summary: [], encrypted_content: 'opaque' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.incomplete', response: body }]));
    const result = await new ResponsesClient(aiConfig).create({ ...request, allowIncomplete: true }, signal());
    expect(result.status).toBe('incomplete');
    expect(result.calls).toEqual([]);
    expect(result.output).toHaveLength(1);
  });

  it('accepts completed JSON despite stream:true and case-insensitive MIME types', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(responseObject('resp_json')),
      { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } }));
    expect((await new ResponsesClient(aiConfig).create(request, signal())).text).toBe('Complete.');
    const streamed = complete();
    streamed.headers.set('Content-Type', 'Text/Event-Stream; charset=utf-8');
    fetch.mockResolvedValue(streamed);
    expect((await new ResponsesClient(aiConfig).create(request, signal())).text).toBe('Complete.');
  });

  it('JSON fallback does not accept Chat Completions or incomplete calls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'legacy' } }] }),
      { headers: { 'Content-Type': 'application/json' } }));
    await expect(new ResponsesClient(aiConfig).create(request, signal())).rejects.toThrow();
  });
});

describe('Bounded, explicit capability fallback', () => {
  it('learns only unsupported options within a client; changed bodies get new idempotency keys', async () => {
    const bodies: any[] = [];
    const keys: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      keys.push((init!.headers as Record<string, string>)['Idempotency-Key']);
      if (bodies.length === 1) return unsupported('prompt_cache_key');
      if (bodies.length === 2) return unsupported('tools[0].strict');
      return complete();
    });
    const client = new ResponsesClient(aiConfig);
    await client.create(request, signal());
    await client.create(request, signal());
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(bodies[0].tools[0].strict).toBe(true);
    expect(bodies[1]).not.toHaveProperty('prompt_cache_key');
    expect(bodies[2].tools.every((tool: any) => tool.strict === false)).toBe(true);
    expect(bodies[3]).not.toHaveProperty('prompt_cache_key');
    expect(bodies.every(body => body.store === false && !body.previous_response_id)).toBe(true);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(AGENT_TOOLS.every(tool => tool.strict)).toBe(true);
    await new ResponsesClient(aiConfig).create(request, signal());
    expect(bodies[4]).toHaveProperty('prompt_cache_key'); // no cross-provider/global capability cache
  });

  it.each(['truncation', 'include', 'parallel_tool_calls', 'tool_choice'])('can omit explicitly unsupported %s', async param => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(unsupported(param)).mockResolvedValueOnce(complete());
    await new ResponsesClient(aiConfig).create(request, signal());
    const first = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    const next = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(first).toHaveProperty(param);
    expect(next).not.toHaveProperty(param);
    expect(next.store).toBe(false);
    expect(next.input).toEqual(first.input);
    expect(next.instructions).toBe(first.instructions);
  });

  it('falls back from unsupported JSON schema guidance without abandoning local validation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(unsupported('text.format.type'))
      .mockResolvedValueOnce(new Response(JSON.stringify(responseObject('resp_aux', '{}'))));
    const result = await new ResponsesClient(aiConfig).create({ ...request, purpose: 'memory',
      tools: undefined, stream: false, text: { format: MEMORY_FORMAT } }, signal());
    expect(result.text).toBe('{}'); // Caller must validate; no fake success/schema repair here.
    const next = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(next).not.toHaveProperty('text');
    expect(next.instructions).toContain(JSON.stringify(MEMORY_FORMAT.schema));
    expect(next.instructions).toContain(request.instructions);
    expect(next.store).toBe(false);
  });

  it.each([
    ['invalid_request_error', 'model', 'invalid request'],
    ['context_length_exceeded', 'prompt_cache_key', 'unsupported prompt_cache_key in evidence'],
    ['unsupported_parameter', 'store', 'Use store:true'],
    ['unsupported_parameter', 'tools', 'tools not supported'],
    ['invalid_api_key', 'prompt_cache_key', 'unsupported prompt_cache_key'],
    ['unsupported_value', 'max_output_tokens', 'maximum is 4096'],
  ])('does not downgrade essential fields, budgets, or unrelated failures (%s/%s)', async (code, param, message) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code, param, message } }), { status: 400 }));
    await expect(new ResponsesClient(aiConfig).create(request, signal())).rejects.toMatchObject({ code: 'responses_http', status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops when a supposedly unsupported option is already absent', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => unsupported('prompt_cache_key'));
    await expect(new ResponsesClient(aiConfig).create(request, signal())).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds a sequence of distinct unsupported options to six compatibility corrections', async () => {
    const options = ['prompt_cache_key', 'truncation', 'include', 'parallel_tool_calls', 'tool_choice', 'tools[0].strict'];
    let index = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      index < options.length ? unsupported(options[index++]) : complete());
    await new ResponsesClient(aiConfig).create(request, signal());
    expect(fetch).toHaveBeenCalledTimes(7);
    const final = JSON.parse(fetch.mock.calls[6][1]!.body as string);
    expect(final.store).toBe(false);
    expect(final.tools[0].strict).toBe(false);
  });

  it('honors bounded Retry-After and keeps the key stable for identical transient retries', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(complete());
    const pending = new ResponsesClient(aiConfig).create(request, signal());
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    const keys = fetch.mock.calls.map(([, init]) => (init!.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
    expect(retryAfterMs('999999')).toBe(30_000);
    expect(retryAfterMs('bad')).toBeUndefined();
  });
});

describe('Auxiliary memory compatibility', () => {
  it('can summarize memory when a gateway ignores the optional JSON Schema parameter', async () => {
    const output = JSON.stringify({ workLog: { mode: 'create', title: 'Inspect Linux', summary: 'Linux inspected' },
      knowledge: [{ action: 'set', category: 'config', key: 'os_name', value: 'Linux' }] });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(unsupported('text.format'))
      .mockImplementation(async () => Response.json(responseObject('memory', output)));
    const result = await distillMemory({ ...aiConfig, max_output_tokens: 1024 },
      { taskId: 'task-1', goal: 'Inspect Linux', conversation: 'Linux inspected', locale: 'en-US', timezone: 'UTC' },
      { workLogs: [], knowledge: [], revision: 4 }, signal());
    expect(result).toMatchObject({ expectedRevision: 4, knowledge: [{ key: 'os_name', value: 'Linux' }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).max_output_tokens).toBe(1024);
  });
});

describe('Safe diagnostics and model budgets', () => {
  it('retains only allowlisted diagnostics, never error bodies, keys or provider headers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'context_length_exceeded', param: 'input', message: 'SECRET_INPUT test-key Bearer SECRET',
      request_id: 'SECRET_REQUEST_ID', extra: '<script>SECRET</script>',
    } }), { status: 400, headers: { 'x-request-id': 'SECRET_PROVIDER_HEADER' } }));
    const error = await new ResponsesClient(aiConfig).create({ ...request, purpose: 'checkpoint' }, signal()).catch(e => e);
    expect(error.diagnostics).toMatchObject({ purpose: 'checkpoint', stage: 'http',
      providerCode: 'context_length_exceeded', parameter: 'input', requestId: expect.any(String) });
    expect(JSON.stringify(error)).not.toMatch(/SECRET|test-key|Bearer/);
    expect(error.message).toBe('responses_http');
  });

  it('extracts safe SSE failure metadata without retrying a started response', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', response: { error: { code: 'server_error', message: 'SECRET' } } },
    ]));
    const error = await new ResponsesClient(aiConfig).create(request, signal()).catch(e => e);
    expect(error).toMatchObject({ code: 'responses_failed', diagnostics: { stage: 'stream', providerCode: 'server_error' } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain('SECRET');
  });

  it('bounds oversized error bodies and respects abort while reading an error', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('x'.repeat(40_000), { status: 400 }));
    await expect(new ResponsesClient(aiConfig).create(request, signal())).rejects.toMatchObject({ code: 'responses_http' });
    const controller = new AbortController();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} }), { status: 400 }));
    const pending = new ResponsesClient(aiConfig).create(request, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
  });

  it('cancels a stalled error body at its independent diagnostic deadline', async () => {
    const deadline = new AbortController();
    const cancel = vi.fn();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start() {}, cancel }), { status: 400 }));
    const pending = new ResponsesClient(aiConfig).create(request, signal());
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(2000));
    deadline.abort(new Error('diagnostic_timeout'));
    await expect(pending).rejects.toMatchObject({ code: 'responses_http', status: 400 });
    expect(cancel).toHaveBeenCalled();
  });

  it.each(['main', 'checkpoint', 'memory'] as const)('caps %s output to configured limits', async purpose => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(complete());
    await new ResponsesClient({ ...aiConfig, context_window: 32_768, max_output_tokens: 1024 })
      .create({ ...request, purpose }, signal());
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).max_output_tokens).toBe(1024);
  });

  it('rejects an oversized context locally before making any request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(new ResponsesClient({ ...aiConfig, context_window: 8192, max_output_tokens: 1024 })
      .create({ ...request, input: [{ role: 'user', content: 'x'.repeat(24_000) }] }, signal()))
      .rejects.toMatchObject({ code: 'responses_budget' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
