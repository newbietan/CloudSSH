import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../src/worker/agent/core';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { aiConfig, compactedWindow, compactReply, functionCall, reply, responseObject, sse } from './agent/responses-fixtures';

vi.mock('../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => vi.restoreAllMocks());
function setup(contextWindow = 64_000) {
  const frames: any[] = [];
  const exec = vi.fn(async (command: string) => ({ stdout: 'observed', stderr: '', exitCode: command === 'inspect_43' ? 1 : 0 }));
  const agent = new AgentCore(new TerminalContext(), frame => frames.push(frame),
    async () => ({ ...aiConfig, context_window: contextWindow }), exec, async () => false);
  return { agent, frames, exec };
}

describe('Native long-task compaction in AgentCore', () => {
  it('continues after 86 settled steps without replay and preserves exact recent native output', async () => {
    const { agent, frames, exec } = setup(256_000);
    const requests: any[] = [];
    const retained = [...compactedWindow, functionCall('retained_only'),
      { type: 'function_call_output' as const, call_id: 'retained_only', output: 'EXACT_RECENT_RESULT' }];
    let steps = 0;
    let compactions = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      if (String(url).endsWith('/compact')) { compactions++; return compactReply(retained); }
      if (steps++ >= 86) return reply('final', 'Inspection complete.');
      const call = functionCall(`call_${steps}`, 'execute_command', { command: `inspect_${steps}`, timeout_ms: null });
      const response = responseObject(`response_${steps}`, '', [call]);
      response.usage.input_tokens = steps === 86 ? 240_000 : 1000;
      return sse([{ type: 'response.completed', response }]);
    });
    await agent.handleAgentStart('1', 'Inspect the blog and fail2ban; never change firewall rules.');
    expect(compactions).toBe(1);
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed', usage: { checkpointCalls: 1 } });
    expect(frames.filter(frame => frame.subType === 'error')).toEqual([]);
    expect(frames).toContainEqual(expect.objectContaining({ subType: 'context_status', compacted: true, checkpointSource: 'native' }));
    const commands = exec.mock.calls.map(([command]) => command).filter(command => command.startsWith('inspect_'));
    expect(commands).toHaveLength(86);
    expect(new Set(commands).size).toBe(86);
    expect(exec.mock.calls.some(([command]) => command === 'free -m')).toBe(false); // retained call is history, never dispatch
    const next = requests.at(-1);
    expect(next.input.slice(0, retained.length)).toEqual(retained);
    const factItem = next.input.find((item: any) => typeof item.content === 'string' && item.content.includes('[UNTRUSTED OBSERVATION: execution facts]'));
    const ledger = JSON.parse(factItem.content.split('\n')[1]);
    expect(ledger.rows).toHaveLength(86);
    expect(ledger.rows.find((row: any[]) => row[2] === 'inspect_43').slice(3)).toEqual(['failed', true, 1]);
    expect(JSON.stringify(next.input)).toContain('never change firewall rules');
    expect(JSON.stringify(frames)).not.toContain('OPAQUE_COMPACTION_STATE');
  });

  it('preserves unaccepted native output and ledger when the first post-compact request fails', async () => {
    const { agent, frames, exec } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      if (requests.length === 1) {
        const response = responseObject('first', '', [functionCall()]); response.usage.input_tokens = 55_000;
        return sse([{ type: 'response.completed', response }]);
      }
      if (String(url).endsWith('/compact')) return compactReply();
      if (requests.length === 3) return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
      return reply('resumed', 'Current state verified.');
    });
    await agent.handleAgentStart('1', 'Inspect nginx; do not restart it.');
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'failed' });
    await agent.handleAgentStart('1', 'Continue the interrupted task');
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed' });
    expect(requests).toHaveLength(4);
    expect(requests[3].input.slice(0, compactedWindow.length)).toEqual(compactedWindow);
    for (const text of ['execution facts', 'do not restart it', 'Continue the interrupted task']) expect(JSON.stringify(requests[3].input)).toContain(text);
    expect(exec.mock.calls.filter(([command]) => command === 'free -m')).toHaveLength(1);
  });

  it.each([false, true])('keeps native history and settled outputs when compact fails (unsupported=%s)', async unsupported => {
    const { agent, frames } = setup();
    const context = (agent as any).context;
    if (!unsupported) vi.spyOn(context, 'fitsBudget').mockReturnValue(false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/compact')) return unsupported ? new Response('', { status: 404 }) : compactReply();
      const response = responseObject('first', '', [functionCall()]); response.usage.input_tokens = 55_000;
      return sse([{ type: 'response.completed', response }]);
    });
    await agent.handleAgentStart('1', 'Inspect');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(frames.find(frame => frame.subType === 'error')).toMatchObject({ code: unsupported ? 'responses_compaction_unavailable' : 'responses_budget' });
    expect(context.history).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_1' }));
    expect(context.pending).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }));
    expect(frames.some(frame => frame.subType === 'context_status' && frame.compacted)).toBe(false);
  });

  it('reset during native compaction cannot replace the new session or replay commands', async () => {
    const { agent, frames, exec } = setup();
    let requests = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (++requests === 1) {
        const response = responseObject('first', '', [functionCall()]); response.usage.input_tokens = 55_000;
        return sse([{ type: 'response.completed', response }]);
      }
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    });
    const pending = agent.handleAgentStart('1', 'Inspect');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    agent.resetSession();
    await pending;
    expect((agent as any).context.buildInput()).toEqual([]);
    expect(frames.filter(frame => frame.subType === 'context_status' && frame.compacted)).toEqual([]);
    expect(exec.mock.calls.filter(([command]) => command === 'free -m')).toHaveLength(1);
    expect(agent.getStatus()).toBe('idle');
  });
});
