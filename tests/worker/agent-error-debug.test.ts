import { describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';

const requestId = '12345678-1234-4123-8123-123456789abc';
function setup(debugMode: boolean) {
  const ws: { send: ReturnType<typeof vi.fn>; readyState: number } = { send: vi.fn(), readyState: WebSocket.OPEN };
  const session = new SSHSession(ws as unknown as WebSocket, { close: vi.fn() }, {
    host: 'ssh.example.com', port: 22, username: 'alice', authMethod: 'password', password: 'SECRET',
  }, true, debugMode);
  return { ws, internal: session as any };
}

const diagnostics = { purpose: 'checkpoint', stage: 'http', parameter: 'text.format',
  providerCode: 'unsupported_parameter', requestId, incompleteReason: 'max_output_tokens',
  requestedOutputTokens: 8192, outputTokens: 8000, reasoningTokens: 7900,
  message: 'SECRET_PROVIDER_BODY', api_key: 'SECRET_KEY', upstreamRequestId: 'SECRET_HEADER' };

describe('Agent error diagnostics debug boundary', () => {
  it.each([false, true])('isolates main/checkpoint and memory diagnostics with DEBUG_MODE=%s', debugMode => {
    const { ws, internal } = setup(debugMode);
    for (const purpose of ['main', 'checkpoint', 'memory']) {
      ws.send.mockClear();
      const frame = { type: 'agent_frame', subType: purpose === 'memory' ? 'memory_status' : 'error',
        code: purpose === 'memory' ? 'memory_failed' : 'responses_http',
        ...(purpose === 'memory' ? { errorCode: 'responses_http' } : {}),
        status: 400, diagnostics: { ...diagnostics, purpose } };
      internal.sendAgentFrame(frame);
      const sent = ws.send.mock.calls.map(([value]) => JSON.parse(value));
      const normal = sent.filter(value => value.type === 'agent_frame');
      expect(normal).toEqual([{ ...frame, diagnostics: { purpose } }]);
      expect(JSON.stringify(normal)).not.toMatch(/text\.format|unsupported_parameter|12345678|8192|8000|7900|SECRET/);
      const debug = sent.filter(value => value.type === 'debug');
      expect(debug).toHaveLength(debugMode ? 1 : 0);
      if (debugMode) {
        for (const detail of [purpose, 'responses_http', '400', 'text.format', 'unsupported_parameter',
          requestId, '8192', '8000', '7900']) expect(debug[0].message).toContain(detail);
      }
      expect(JSON.stringify(sent)).not.toContain('SECRET');
      expect(frame.diagnostics).toEqual({ ...diagnostics, purpose }); // No mutation of error evidence.
    }
  });

  it('does not turn unknown diagnostic fields into terminal escape sequences or user copy', () => {
    const { ws, internal } = setup(true);
    internal.sendAgentFrame({ type: 'agent_frame', subType: 'error', code: 'responses_http',
      diagnostics: { purpose: '\u001b[2JSECRET', requestId: 'SECRET', message: 'SECRET' } });
    const sent = ws.send.mock.calls.map(([value]) => JSON.parse(value));
    expect(sent).toEqual([
      { type: 'debug', message: 'Agent Responses failure: {"code":"responses_http"}' },
      { type: 'agent_frame', subType: 'error', code: 'responses_http' },
    ]);
  });

  it('preserves ordinary Agent frames and sends nothing when the socket is closed', () => {
    const { ws, internal } = setup(true);
    const frame = { type: 'agent_frame', subType: 'stream_chunk', content: 'answer' };
    internal.sendAgentFrame(frame);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(frame));
    ws.send.mockClear();
    ws.readyState = WebSocket.CLOSED;
    internal.sendAgentFrame({ ...frame, diagnostics });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
