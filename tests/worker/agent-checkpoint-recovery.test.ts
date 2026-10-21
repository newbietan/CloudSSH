/// <reference lib="es2022" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../src/worker/agent/core';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { aiConfig, functionCall, reply, responseObject, sse } from './agent/responses-fixtures';

vi.mock('../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => vi.restoreAllMocks());

function setup(contextWindow = 64_000) {
  const frames: any[] = [];
  const exec = vi.fn(async (command: string) => ({ stdout: 'observed output', stderr: '', exitCode: command === 'inspect_43' ? 1 : 0 }));
  const agent = new AgentCore(new TerminalContext(), frame => frames.push(frame),
    async () => ({ ...aiConfig, context_window: contextWindow }), exec, async () => false);
  return { agent, frames, exec };
}

function seedOlderHistory(agent: AgentCore) {
  const context = (agent as any).context;
  for (let i = 0; i < 4; i++) {
    context.beginTurn(`Earlier request ${i}`);
    context.accept({ ...responseObject(`old_${i}`, 'Earlier observation'), text: 'Earlier observation', calls: [] }, context.buildInput());
  }
}

describe('Application-level long-task compaction in AgentCore', () => {
  it('continues after 86 settled steps without replay, compacting older turns and preserving recent interaction', async () => {
    const { agent, frames, exec } = setup(256_000);
    const requests: any[] = [];
    let steps = 0;
    let compactions = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      if (!body.stream) {
        compactions++;
        return Response.json(responseObject('checkpoint_summary', 'Successfully summarized earlier steps; blog inspected.'));
      }
      if (steps >= 86) return reply('final', 'Inspection complete.');
      steps++;
      const call = functionCall(`call_${steps}`, 'execute_command', { command: `inspect_${steps}`, timeout_ms: null });
      const response = responseObject(`response_${steps}`, '', [call]);
      response.usage.input_tokens = steps === 86 ? 240_000 : 1000;
      return sse([{ type: 'response.completed', response }]);
    });

    await agent.handleAgentStart('1', 'Inspect the blog and fail2ban; never change firewall rules.');
    expect(compactions).toBe(1);
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed', usage: { checkpointCalls: 1 } });
    expect(frames.filter(frame => frame.subType === 'error')).toEqual([]);
    expect(frames).toContainEqual(expect.objectContaining({ subType: 'context_status', compacted: true, checkpointSource: 'model' }));

    const commands = exec.mock.calls.map(([command]) => command).filter(command => command.startsWith('inspect_'));
    expect(commands).toHaveLength(86);
    expect(new Set(commands).size).toBe(86);

    const next = requests.at(-1);
    expect(JSON.stringify(next.input)).toContain('blog inspected');
    expect(next.input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_86' }));
    expect(next.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_86' }));
    expect(JSON.stringify(next.input)).toContain('never change firewall rules');
  });

  it('continues with recent conversation if the summary request fails', async () => {
    const { agent, frames } = setup(256_000);
    let steps = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      if (!body.stream) {
        return new Response('Server Error', { status: 500 });
      }
      if (steps++ >= 5) return reply('final', 'Done.');
      const call = functionCall(`call_${steps}`);
      const response = responseObject(`resp_${steps}`, '', [call]);
      response.usage.input_tokens = steps >= 3 ? 240_000 : 1000;
      return sse([{ type: 'response.completed', response }]);
    });

    await agent.handleAgentStart('1', 'Inspect system');
    expect(frames).toContainEqual(expect.objectContaining({ subType: 'context_status', compacted: true, checkpointSource: 'local' }));
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed' });
  });

  it('keeps the summarized conversation when the first continuation request fails', async () => {
    const { agent, frames } = setup();
    seedOlderHistory(agent);
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      if (requests.length === 1) {
        const response = responseObject('turn1', 'Initial check complete.'); response.usage.input_tokens = 55_000;
        return sse([{ type: 'response.completed', response }]);
      }
      if (!body.stream) {
        return Response.json(responseObject('cp', 'Summary of nginx inspection.'));
      }
      if (requests.length === 3) return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
      return reply('resumed', 'Current state verified.');
    });

    await agent.handleAgentStart('1', 'Inspect nginx; do not restart it.');
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed' });
    await agent.handleAgentStart('1', 'Now check firewall');
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'failed' });
    await agent.handleAgentStart('1', 'Continue the interrupted task');
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed' });
    expect(requests).toHaveLength(4);
    for (const text of ['Summary of nginx inspection', 'do not restart it', 'Continue the interrupted task']) {
      expect(JSON.stringify(requests[3].input)).toContain(text);
    }
  });

  it('reset during compaction cancels execution and leaves session clean', async () => {
    const { agent, frames } = setup();
    seedOlderHistory(agent);
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (++requests === 1) {
        const response = responseObject('turn1', 'Initial check done.'); response.usage.input_tokens = 55_000;
        return sse([{ type: 'response.completed', response }]);
      }
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    });
    await agent.handleAgentStart('1', 'Initial setup');
    const pending = agent.handleAgentStart('1', 'Inspect next');
    await vi.waitFor(() => expect(requests).toBeGreaterThanOrEqual(2));
    agent.resetSession();
    await pending;
    expect((agent as any).context.buildInput()).toEqual([]);
    expect(frames.filter(frame => frame.subType === 'context_status' && frame.compacted)).toEqual([]);
    expect(agent.getStatus()).toBe('idle');
  });
});
