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
    (body.output as any[]).unshift({ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'PRIVATE' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    const onText = vi.fn();
    const result = await new ResponsesClient(aiConfig).create(request, new AbortController().signal, onText);
    expect(result.output).toEqual(body.output);
    expect(result.text).toBe('Visible');
    expect(onText).not.toHaveBeenCalled();
  });

  it('accepts reasoning items with empty or optional summary from compatible providers without breaking tool flow', async () => {
    const body = responseObject('resp_1', 'Ready', [functionCall()]);
    (body.output as any[]).unshift({ type: 'reasoning', id: 'rs_openrouter', summary: [] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    const result = await new ResponsesClient(aiConfig).create(request, new AbortController().signal);
    expect(result.calls).toHaveLength(1);
    expect(result.output.some(item => item.type === 'reasoning')).toBe(true);
  });

  it('handles terminal data: [DONE] frame and unknown proxy SSE events gracefully', async () => {
    const body = responseObject('resp_1', '服务器硬件正常。');
    // 模拟网关在 completed 之后甚至粘包发来 data: [DONE]
    const customStream = new Response(new ReadableStream({
      async start(controller) {
        const text = 'event: ping\ndata: {"type":"ping"}\n\n' +
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"服务器硬件正常。"}\n\n' +
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n` +
          'data: [DONE]\n\n';
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(customStream);
    const onText = vi.fn();
    const result = await new ResponsesClient(aiConfig).create(request, new AbortController().signal, onText);
    expect(result.text).toBe('服务器硬件正常。');
    expect(onText).toHaveBeenCalledWith('服务器硬件正常。');
  });

  it('normalizes tool call identifier across call_id, callId, and id formats and accepts omitted item status', async () => {
    const body = {
      id: 'resp_call_id',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          callId: 'call_camel_case',
          name: 'execute_command',
          arguments: '{"command":"df -h","timeout_ms":null}',
          // 故意不传 item.status，模拟 OpenRouter / 第三方服务商常见返回
        },
      ],
      usage: { input_tokens: 100.5, output_tokens: 20.2, total_tokens: 120.7,
        output_tokens_details: { reasoning_tokens: 30 } }, // 浮点数与倒挂元数据容错
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'response.completed', response: body }]));
    const result = await new ResponsesClient(aiConfig).create(request, new AbortController().signal);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].call_id).toBe('call_camel_case');
    expect(result.calls[0].status).toBe('completed');
    expect(result.usage?.input_tokens).toBe(101);
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

  it('uses strict schemas while providing resilient coercion for smaller/varying models', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool).not.toHaveProperty('function');
      expect(tool.parameters.required).toEqual(Object.keys(tool.parameters.properties));
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    // 标准完整参数
    expect(parseToolArguments('execute_command', '{"command":"df -h","timeout_ms":null}')).toEqual({ command: 'df -h', timeout_ms: null });
    // 弱模型常见容错：漏传可选为null的字段，回退默认 null
    expect(parseToolArguments('execute_command', '{"command":"df -h"}')).toEqual({ command: 'df -h', timeout_ms: null });
    // 弱模型常见容错：数字以字符串传参，自动类型软转换
    expect(parseToolArguments('execute_command', '{"command":"df -h","timeout_ms":"15000"}')).toEqual({ command: 'df -h', timeout_ms: 15000 });
    // 弱模型常见容错：多余幻觉字段静默忽略
    expect(parseToolArguments('execute_command', '{"command":"df -h","timeout_ms":null,"extra":"noise"}')).toEqual({ command: 'df -h', timeout_ms: null });
    // 弱模型常见容错：参数外层包裹 markdown ```json 标记
    expect(parseToolArguments('execute_command', '```json\n{"command":"df -h"}\n```')).toEqual({ command: 'df -h', timeout_ms: null });
    // 弱模型常见容错：空字符串在允许为 null 字段上安全归一为 null
    expect(parseToolArguments('docker_manage', '{"action":"ps","target":"","options":""}')).toEqual({ action: 'ps', target: null, options: null });

    // 真正非法的参数依然严格抛错
    for (const args of ['not JSON', '[]', '{"command":5,"timeout_ms":null}', '{"command":"   "}', '{"command":"df","timeout_ms":999999}']) {
      expect(() => parseToolArguments('execute_command', args)).toThrow();
    }
    expect(() => parseToolArguments('unknown', '{}')).toThrow();
    expect(() => parseToolArguments('docker_manage', '{"action":"logs","target":null,"options":null}')).toThrow();
  });
});
