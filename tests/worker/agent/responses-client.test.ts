import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeAIBaseUrl } from '../../../src/ai-endpoint';
import { ResponsesClient } from '../../../src/worker/agent/responses-client';
import { AGENT_TOOLS, parseToolArguments } from '../../../src/worker/agent/tools';
import { aiConfig, functionCall, responseObject, sse } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));

const request = { input: [{ role: 'user' as const, content: 'Inspect' }], instructions: 'Stable', stream: true, tools: AGENT_TOOLS, max_output_tokens: 8192 };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Responses protocol and execution boundary', () => {
  it('normalizes only HTTPS roots/responses, preserving credential-bound path case', () => {
    expect(normalizeAIBaseUrl('https://API.EXAMPLE.COM/V1/responses/')).toBe('https://api.example.com/V1');
    for (const address of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret',
      'https://example.com/v1#fragment', 'https://example.com/v1/chat/completions', 'https://example.com/v1/models', 'garbage']) {
      expect(() => normalizeAIBaseUrl(address)).toThrow();
    }
  });

  it('handles UTF-8/chunk boundaries and CRLF, using completed output and call_id', async () => {
    const call = functionCall();
    const onText = vi.fn();
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'response.output_item.added', item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '{' },
      { type: 'response.reasoning_text.delta', delta: 'PRIVATE REASONING' },
      { type: 'response.output_text.delta', delta: '检查服务器' },
      { type: 'response.completed', response: responseObject('resp_1', '检查服务器', [call]) },
    ], 3, true));
    const result = await new ResponsesClient({ ...aiConfig, base_url: aiConfig.base_url + '/responses' }).create(request, new AbortController().signal, onText);
    expect(result.calls[0].call_id).toBe('call_1');
    expect(onText).toHaveBeenCalledExactlyOnceWith('检查服务器');
    expect(result.usage?.input_tokens_details?.cached_tokens).toBe(80);
    expect(mock).toHaveBeenCalledWith(aiConfig.base_url + '/responses', expect.objectContaining({ redirect: 'manual' }));
  });

  it.each(['response.incomplete', 'response.failed', 'error'])('does not accept %s as successful output', async type => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type, response: { status: 'incomplete' } }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toThrow();
  });

  it('rejects EOF without completed and never retries a started stream', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.output_text.delta', delta: 'partial' }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_stream' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])('accepts stateless responses without a storage echo (%s)', async store => {
    const response = { ...responseObject('resp_1'), store };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response }]));
    expect((await new ResponsesClient(aiConfig).create(request, new AbortController().signal)).text).toBe('Complete.');
  });

  it('rejects explicit storage and duplicate call IDs', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed',
      response: { ...responseObject('resp_2'), store: true } }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_storage' });
    mock.mockResolvedValue(sse([{ type: 'response.completed', response: responseObject('resp_3', '', [functionCall(), functionCall()]) }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_invalid' });
  });

  it('rejects incomplete function items and legacy payloads', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: responseObject('resp_1', '', [{ ...functionCall(), status: 'in_progress' } as any]) }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toThrow();
    mock.mockResolvedValue(sse([{ choices: [{ delta: { content: 'old format' } }] }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toThrow();
  });

  it('blocks redirects and never exposes upstream error bodies/keys', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(aiConfig.api_key, { status: 302 }));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_redirect' });
    mock.mockResolvedValue(new Response(aiConfig.api_key, { status: 401 }));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ message: 'responses_http', status: 401 });
  });

  it('aborts a blocked body read promptly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const controller = new AbortController();
    const pending = new ResponsesClient(aiConfig).create(request, controller.signal);
    controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
  });

  it('reads auxiliary structured output without tools, storage, or a response chain', async () => {
    const body = responseObject('resp_aux', '{"workLog":null,"knowledge":[]}', [], { store: false });
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    const result = await new ResponsesClient(aiConfig).create({ ...request, tools: undefined, stream: false }, new AbortController().signal);
    expect(JSON.parse(result.text).workLog).toBeNull();
    const sent = JSON.parse(mock.mock.calls[0][1]?.body as string);
    expect(sent).not.toHaveProperty('messages');
    expect(sent).not.toHaveProperty('previous_response_id');
  });

  it('bounds malformed event buffering', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: ' + 'x'.repeat(1_000_001), { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_invalid' });
  });

  it('never sends storage/chaining overrides supplied at runtime', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: responseObject('resp_1') }]));
    await new ResponsesClient(aiConfig).create({ ...request, store: true, previous_response_id: 'ignored' } as any, new AbortController().signal);
    const sent = JSON.parse(mock.mock.calls[0][1]?.body as string);
    expect(sent.store).toBe(false);
    expect(sent.truncation).toBe('disabled');
    expect(sent).not.toHaveProperty('previous_response_id');
  });

  it('treats HTTP failures uniformly without exposing provider bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('SECRET_PROVIDER_BODY', { status: 400 }));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_http', message: 'responses_http' });
  });

  it('preserves complete native reasoning and messages for replay without exposing reasoning as text', async () => {
    const body = responseObject('resp_1', 'Visible', [functionCall()]);
    (body.output as any[]).unshift({ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'PRIVATE' }], encrypted_content: 'OPAQUE' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    const onText = vi.fn();
    const result = await new ResponsesClient(aiConfig).create(request, new AbortController().signal, onText);
    expect(result.output).toEqual(body.output);
    expect(result.text).toBe('Visible');
    expect(onText).not.toHaveBeenCalled();
  });

  it('fails closed if reasoning cannot be replayed in stateless tool requests', async () => {
    const body = responseObject('resp_1');
    (body.output as any[]).unshift({ type: 'reasoning', id: 'rs_1', summary: [] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_reasoning' });
  });

  it('does not execute calls alongside a model refusal', async () => {
    const body = responseObject('resp_1', '', [functionCall()]);
    (body.output as any[]).push({ type: 'message', id: 'msg_refusal', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Declined' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    await expect(new ResponsesClient(aiConfig).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_invalid' });
  });

  it('retries only bounded transient HTTP failures with one idempotency key', async () => {
    vi.useFakeTimers();
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('retry', { status: 429 }))
      .mockResolvedValueOnce(new Response('retry', { status: 503 }))
      .mockResolvedValueOnce(sse([{ type: 'response.completed', response: responseObject('resp_1') }]));
    const pending = new ResponsesClient(aiConfig).create(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).id).toBe('resp_1');
    const keys = mock.mock.calls.map(([, init]) => ((init?.headers ?? {}) as Record<string, string>)['Idempotency-Key']);
    expect(keys).toHaveLength(3); expect(new Set(keys).size).toBe(1);
  });

  it('uses strict schemas but still validates every argument locally', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool).not.toHaveProperty('function');
      expect(tool.parameters.required).toEqual(Object.keys(tool.parameters.properties));
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(parseToolArguments('execute_command', '{"command":"df -h","timeout_ms":null}')).toEqual({ command: 'df -h', timeout_ms: null });
    for (const args of ['not JSON', '[]', '{"command":5,"timeout_ms":null}', '{"command":"df","timeout_ms":null,"evil":true}', '{"command":"df"}', '{"command":"df","timeout_ms":999999}']) {
      expect(() => parseToolArguments('execute_command', args)).toThrow();
    }
    expect(() => parseToolArguments('unknown', '{}')).toThrow();
    expect(() => parseToolArguments('docker_manage', '{"action":"logs","target":null,"options":null}')).toThrow();
  });
});
