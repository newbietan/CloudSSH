import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../src/worker/agent/core';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { SSHSession } from '../../src/worker/ssh-session';
import { aiConfig, functionCall, reply } from './agent/responses-fixtures';

vi.mock('../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => vi.restoreAllMocks());

function createSession(options: { anonymous?: boolean; share?: boolean } = {}) {
  const frames: any[] = [];
  const ws = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data)), close: vi.fn() };
  const session = new SSHSession(ws as unknown as WebSocket, { close: vi.fn() }, {
    host: 'ssh.example.com', port: 22, username: 'alice', password: '', authMethod: 'password',
    ...(options.share ? { sessionPolicy: {
      source: 'share' as const, shareId: 'share', shareRef: 'ref', allowAgent: false,
      allowSftp: true, allowMetadataMutation: false, allowHostKeyMutation: false,
      allowReconnect: false, sessionExpiresAt: Date.now() + 60_000,
    } } : {}),
  }, true, false, undefined, undefined, options.anonymous ? undefined : '1', '42');
  const internal = session as any;
  internal.state = 'ready';
  internal.fetchAgentAIConfig = () => new Promise(() => {});
  return { session, internal, frames };
}

async function start(session: SSHSession) {
  await session.handleWebSocketMessage(JSON.stringify({
    type: 'agent_start', message: 'inspect the server', requestId: 'original-request',
  }));
}

async function cleanup(session: SSHSession) {
  const core = (session as any).agentCore;
  session.close(true);
  await core?.activeRun;
}

describe('Agent session state synchronization', () => {
  it('finishes a real Agent run while offline and recovers its result without repeating the tool', async () => {
    const { session, internal, frames } = createSession();
    internal.fetchAgentAIConfig = async () => aiConfig;
    let finishTool!: () => void;
    const toolGate = new Promise<void>(resolve => { finishTool = resolve; });
    const execute = vi.spyOn(internal, 'executeAgentCommand').mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'free -m') await toolGate;
      return { stdout: 'Linux', stderr: '', exitCode: 0 };
    });
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      return ++requests === 1 ? reply('first', '', [functionCall()], body)
        : reply('last', 'completed while offline', [], body);
    });
    try {
      await start(session);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('free -m', expect.any(Number), expect.any(AbortSignal)));
      internal.ws.readyState = 3;
      session.setDetached(true);
      frames.length = 0;
      finishTool();
      await internal.agentCore.activeRun;
      expect(frames).toHaveLength(0);
      await session.reattachWebSocket({
        readyState: 1, send: (data: string) => { frames.push(JSON.parse(data)); },
      } as unknown as WebSocket);
      for (const syncId of ['first-sync', 'second-sync']) {
        await session.handleWebSocketMessage(JSON.stringify({ type: 'agent_sync', syncId }));
        expect(frames.at(-1)).toMatchObject({ subType: 'state', syncId, state: {
          phase: 'idle', outcome: 'completed', text: 'completed while offline', requestId: 'original-request',
        } });
      }
      expect(execute.mock.calls.filter(call => call[0] === 'free -m')).toHaveLength(1);
      expect(requests).toBe(2);
    } finally { finishTool(); await cleanup(session); }
  });

  it('queries only the current SSH session even if a client supplies another identity', async () => {
    const first = createSession();
    const second = createSession();
    try {
      await start(first.session);
      await second.session.handleWebSocketMessage(JSON.stringify({
        type: 'agent_sync', syncId: 'other-tab', user_id: '1', requestId: 'original-request',
      }));
      expect(second.frames.at(-1)).toMatchObject({ state: { runId: 0, requestId: null, phase: 'idle' } });
      expect(first.internal.agentCore.getStatus()).toBe('running');
    } finally { await cleanup(first.session); await cleanup(second.session); }
  });

  it('returns running task identity after reattach without treating sync as terminal input or activity', async () => {
    const { session, internal } = createSession();
    try {
      await start(session);
      session.setDetached(true);
      const restored: any[] = [];
      await session.reattachWebSocket({
        readyState: 1, send: (data: string) => { restored.push(JSON.parse(data)); },
      } as unknown as WebSocket);
      const input = vi.spyOn(internal, 'enqueueChannelData');
      const activity = vi.spyOn(session, 'recordUserActivity');
      await session.handleWebSocketMessage(JSON.stringify({ type: 'agent_sync', syncId: 'sync-1' }));
      expect(input).not.toHaveBeenCalled();
      expect(activity).not.toHaveBeenCalled();
      expect(restored).toContainEqual(expect.objectContaining({
        type: 'agent_frame', subType: 'state', syncId: 'sync-1',
        state: expect.objectContaining({ phase: 'thinking', runId: 1, requestId: 'original-request' }),
      }));
    } finally { await cleanup(session); }
  });

  it('recovers the same pending confirmation without approving or executing it', async () => {
    const { session, internal, frames } = createSession();
    try {
      await start(session);
      const waiting = internal.askAgentConfirmation('restart example-service', 'service restart');
      const id = internal.pendingAgentConfirmation.id;
      session.setDetached(true);
      await session.reattachWebSocket({
        readyState: 1, send: (data: string) => { frames.push(JSON.parse(data)); },
      } as unknown as WebSocket);
      await session.handleWebSocketMessage(JSON.stringify({ type: 'agent_sync', syncId: 'sync-2' }));
      expect(frames.at(-1)).toMatchObject({ subType: 'state', state: {
        phase: 'waiting_confirmation', confirmation: {
          confirmationId: id, command: 'restart example-service', reason: 'service restart',
        },
      } });
      expect(internal.pendingAgentConfirmation.id).toBe(id);
      session.handleAgentControl('agent_stop', {});
      expect(await waiting).toBe(false);
    } finally { await cleanup(session); }
  });

  it.each([{ anonymous: true }, { share: true }])('does not disclose task state to an ineligible connection: %j', async options => {
    const { session, internal, frames } = createSession(options);
    const input = vi.spyOn(internal, 'enqueueChannelData');
    try {
      await session.handleWebSocketMessage(JSON.stringify({ type: 'agent_sync', syncId: 'denied' }));
      expect(frames.some(frame => frame.subType === 'state')).toBe(false);
      expect(input).not.toHaveBeenCalled();
    } finally { await cleanup(session); }
  });

  it('reports busy with a machine-readable code so a stale client can resynchronize', async () => {
    const { session, frames } = createSession();
    try {
      await start(session);
      await start(session);
      expect(frames.at(-1)).toMatchObject({ subType: 'error', code: 'agent_busy' });
    } finally { await cleanup(session); }
  });
});

describe('Bounded Agent recovery view', () => {
  it('distinguishes replies but never includes tool arguments, credentials or mutable internal references', () => {
    const agent = new AgentCore(new TerminalContext(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const internal = agent as any;
    internal.emit(0, { subType: 'stream_chunk', content: 'first' });
    internal.emit(0, { subType: 'stream_end', content: 'first' });
    const firstId = agent.getSessionState().textId;
    internal.emit(0, { subType: 'executing', tool: 'execute_command', args: { command: 'SECRET_ARGUMENT' } });
    expect(JSON.stringify(agent.getSessionState())).not.toContain('SECRET_ARGUMENT');
    internal.emit(0, { subType: 'stream_chunk', content: 'second' });
    const state = agent.getSessionState();
    expect(state.textId).toBe(firstId + 1);
    state.text = 'modified outside';
    expect(agent.getSessionState().text).toBe('second');
  });

  it('keeps only bounded visible text, retains completion offline and exposes stopping until cleanup', async () => {
    const agent = new AgentCore(new TerminalContext(), vi.fn(), () => new Promise(() => {}), vi.fn(), vi.fn());
    const run = agent.handleAgentStart('1', 'inspect', 'en-US', undefined, undefined, 'request-1');
    const internal = agent as any;
    try {
      internal.emit(1, { subType: 'stream_chunk', content: 'x'.repeat(100_000) });
      const state = internal.getSessionState();
      expect(state.text.length).toBeLessThanOrEqual(32_000);
      expect(state.textTruncated).toBe(true);
      expect(state.requestId).toBe('request-1');
      const textId = state.textId;
      internal.emit(1, { subType: 'stream_end', content: 'finished offline' });
      internal.emit(1, { subType: 'run_end', outcome: 'completed' });
      expect(internal.getSessionState()).toMatchObject({
        phase: 'idle', outcome: 'completed', text: 'finished offline', textComplete: true, textId,
      });
      internal.emit(1, { subType: 'thinking', iteration: 3 });
      agent.agentAbort('user_stopped');
      expect(internal.getSessionState().phase).toBe('stopping');
    } finally { agent.agentAbort('user_stopped'); await run; }
    expect(internal.getSessionState()).toMatchObject({ phase: 'idle', outcome: 'stopped' });
    agent.resetSession();
    expect(internal.getSessionState()).toMatchObject({ phase: 'idle', requestId: null, text: '' });
  });
});
