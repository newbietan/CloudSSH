import type { ResponseFunctionCall } from '../../../src/worker/agent/types';

export const aiConfig = { base_url: 'https://api.openai.com/v1', model: 'gpt-test', api_key: 'test-key' };

export function functionCall(id = 'call_1', name = 'execute_command', args: Record<string, unknown> = { command: 'free -m', timeout_ms: null }): ResponseFunctionCall {
  return { type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' };
}

export function responseObject(id: string, text = 'Complete.', calls: ResponseFunctionCall[] = [], request: Record<string, any> = {}) {
  return { id, status: 'completed', store: request.store ?? false,
    output: [...calls, ...(text ? [{ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] : [])],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 5 } } };
}

export function sse(events: unknown[], splitBytes = 0, crlf = false): Response {
  const separator = crlf ? '\r\n' : '\n';
  const text = events.map(event => `event: ${(event as any).type}${separator}data: ${JSON.stringify(event)}${separator}${separator}`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (!splitBytes) controller.enqueue(bytes);
    else for (let i = 0; i < bytes.length; i += splitBytes) controller.enqueue(bytes.slice(i, i + splitBytes));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

export function reply(id: string, text = 'Complete.', calls: ResponseFunctionCall[] = [], request: Record<string, any> = {}): Response {
  return sse([...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
    { type: 'response.completed', response: responseObject(id, text, calls, request) }]);
}

export const checkpoint = { goal: 'Inspect nginx', facts: ['Linux server'], operations: ['free -m completed'],
  pending: ['Check nginx'], constraints: ['Do not repeat completed commands'], unknown: [] };
