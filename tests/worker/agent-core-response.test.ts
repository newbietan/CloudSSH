import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../src/worker/agent/core';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { aiConfig, checkpoint, functionCall, reply, responseObject, sse } from './agent/responses-fixtures';

// Protocol fixtures stub DNS; the real outbound guard is covered in responses-ssrf.test.ts.
vi.mock('../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));

function setup(options: any = {}) {
  const frames: any[] = [];
  const terminal = new TerminalContext();
  const exec = vi.fn(async () => ({ stdout: 'Linux', stderr: '', exitCode: 0 }));
  const waits: Promise<unknown>[] = [];
  const agent = new AgentCore(terminal, frame => frames.push(frame), async () => aiConfig,
    options.exec || exec, async () => true, options.config, options.memory, promise => waits.push(promise));
  return { agent, frames, terminal, exec, waits };
}
afterEach(() => vi.restoreAllMocks());

describe('AgentCore Responses delivery and context', () => {
  it('delivers streamed text, then one explicit task completion with usage', async () => {
    const { agent, frames } = setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('resp_1', '服务器正常。'));
    await agent.handleAgentStart('1', '检查服务器');
    expect(agent.getStatus()).toBe('idle');
    expect(frames.find(frame => frame.subType === 'stream_end')?.content).toBe('服务器正常。');
    expect(frames.filter(frame => frame.subType === 'run_end')).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed', usage: { calls: 1, input: 100, cached: 80, output: 20, reasoning: 5 } });
  });

  it('chains only new tool results, keeps instructions/tools stable, and does not resend snapshots', async () => {
    const { agent, exec, terminal } = setup();
    terminal.appendOutput('terminal unchanged');
    const requests: any[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return requests.length === 1 ? reply('resp_1', '先检查内存。', [functionCall()], body) : reply('resp_2', '内存正常。', [], body);
    });
    await agent.handleAgentStart('1', '检查内存');
    expect(exec).toHaveBeenCalledWith('free -m', 10000, expect.any(AbortSignal));
    expect(mock).toHaveBeenCalledTimes(2);
    expect(requests[0]).not.toHaveProperty('messages');
    expect(requests[1].previous_response_id).toBe('resp_1');
    expect(requests[1].input).toEqual([expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' })]);
    expect(requests[1].instructions).toBe(requests[0].instructions);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].prompt_cache_key).toBe(requests[0].prompt_cache_key);
    expect(requests[0].instructions).not.toContain('terminal unchanged');
  });

  it('appends changed terminal observations without changing the instruction prefix', async () => {
    const { agent, terminal } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return reply(`resp_${requests.length}`, '正常', [], body);
    });
    await agent.handleAgentStart('1', '第一轮');
    terminal.appendOutput('new shell output');
    await agent.handleAgentStart('1', '第二轮');
    expect(requests[1].input.some((item: any) => item.content?.includes('new shell output'))).toBe(true);
    expect(requests[1].input.some((item: any) => item.content === '第一轮')).toBe(false);
    expect(requests[1].instructions).toBe(requests[0].instructions);
  });

  it('refreshes environment observations when editing a non-root turn', async () => {
    const { agent, exec } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return reply(`resp_${requests.length}`, '正常', [], body);
    });
    await agent.handleAgentStart('1', 'First');
    await agent.handleAgentStart('1', 'Second');
    await agent.handleAgentStart('1', 'Corrected second', 'zh-CN', 'UTC', 1);
    expect(requests[2].previous_response_id).toBe('resp_1');
    expect(requests[2].input.some((item: any) => item.content?.includes('[UNTRUSTED OBSERVATION: environment]'))).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('records dispatch failures as unknown, never as unexecuted invalid arguments', async () => {
    const { agent } = setup();
    const execute = vi.spyOn((agent as any).toolExecutor, 'execute');
    execute.mockImplementation(async (name) => {
      if (name === 'detect_environment') return JSON.stringify({ environment: 'Linux' });
      throw new Error('Connection lost after dispatch');
    });
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return requests.length === 1 ? reply('resp_1', '', [functionCall()], body) : reply('resp_2', 'Inspect state before retry.', [], body);
    });
    await agent.handleAgentStart('1', 'Inspect');
    const result = JSON.parse(requests[1].input[0].output);
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('executed', false);
    expect(result.instruction).toContain('inspect remote state');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects empty successful responses instead of claiming completion', async () => {
    const { agent, frames } = setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('resp_1', ''));
    await agent.handleAgentStart('1', '测试');
    expect(frames.find(frame => frame.subType === 'error')?.code).toBe('responses_empty');
    expect(frames.at(-1).outcome).toBe('failed');
  });

  it('never executes a call in an incomplete response or exposes reasoning', async () => {
    const { agent, exec, frames } = setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([
      { type: 'response.reasoning_text.delta', delta: 'PRIVATE' },
      { type: 'response.function_call_arguments.delta', delta: '{"command":"reboot"}' },
      { type: 'response.incomplete', response: responseObject('resp_1', '', [functionCall()]) },
    ]));
    await agent.handleAgentStart('1', '检查服务');
    expect(exec).toHaveBeenCalledTimes(1); // initial environment only
    expect(JSON.stringify(frames)).not.toContain('PRIVATE');
    expect(frames.find(frame => frame.subType === 'error')?.code).toBe('responses_incomplete');
    expect((agent as any).context.responseId).toBeUndefined();
  });

  it('invalid arguments and blocked commands return results without unsafe execution', async () => {
    const { agent, exec } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return requests.length === 1 ? reply('resp_1', '', [
        { ...functionCall('bad'), arguments: '{bad json' },
        functionCall('blocked', 'execute_command', { command: 'rm -rf /', timeout_ms: null }),
      ], body) : reply('resp_2', '已拒绝', [], body);
    });
    await agent.handleAgentStart('1', '检查');
    expect(exec).toHaveBeenCalledTimes(1);
    const results = requests[1].input.map((item: any) => JSON.parse(item.output));
    expect(results[0].status).toBe('invalid_arguments');
    expect(results[1].blocked).toBe(true);
  });

  it('keeps long task results immutable in the upstream chain instead of rewriting history', async () => {
    const { agent } = setup({ exec: vi.fn(async () => ({ stdout: 'head' + 'x'.repeat(2000) + 'tail', stderr: '', exitCode: 0 })) });
    let step = 0;
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body); step++;
      return step <= 8 ? reply(`resp_${step}`, '', [functionCall(`call_${step}`, 'execute_command', { command: `ls /tmp/${step}`, timeout_ms: null })], body)
        : reply('resp_final', '排查完成', [], body);
    });
    await agent.handleAgentStart('1', '连续检查');
    expect(requests).toHaveLength(9);
    for (const body of requests.slice(1)) {
      expect(body.input).toHaveLength(1);
      expect(body.input[0].output).toContain('tail');
      expect(body.input[0].output).not.toContain('更早历史');
    }
  });

  it('uses a structured checkpoint at the budget boundary and starts a fresh chain without orphan outputs', async () => {
    const { agent } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      if (!body.stream) return new Response(JSON.stringify(responseObject('resp_checkpoint', JSON.stringify(checkpoint), [], body)));
      if (requests.length === 1) {
        const response = responseObject('resp_1', '', [functionCall()], body);
        response.usage.input_tokens = 55_000; response.usage.total_tokens = 55_020;
        return sse([{ type: 'response.completed', response }]);
      }
      return reply('resp_after', '检查完成', [], body);
    });
    await agent.handleAgentStart('1', '检查 nginx');
    expect(requests).toHaveLength(3);
    expect(requests[1]).toMatchObject({ store: false, stream: false, text: { format: { name: 'agent_checkpoint' } } });
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    expect(requests[2]).not.toHaveProperty('previous_response_id');
    expect(requests[2].input.some((item: any) => item.type === 'function_call_output')).toBe(false);
    expect(JSON.stringify(requests[2].input)).toContain('free -m completed');
  });

  it('fails closed if a checkpoint is invalid and does not abandon the existing chain', async () => {
    const { agent, frames } = setup();
    let step = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      if (!body.stream) return new Response(JSON.stringify(responseObject('aux', '{}', [], body)));
      step++;
      const response = responseObject('resp_1', '', [functionCall()], body);
      response.usage.input_tokens = 55_000; response.usage.total_tokens = 55_020;
      return sse([{ type: 'response.completed', response }]);
    });
    await agent.handleAgentStart('1', '检查');
    expect(step).toBe(1);
    expect((agent as any).context.responseId).toBe('resp_1');
    expect((agent as any).context.pending[0].type).toBe('function_call_output');
    expect(frames.find(frame => frame.subType === 'error')?.code).toBe('responses_schema');
  });

  it('distills interrupted work through a separate structured Responses request and waitUntil', async () => {
    let agent: AgentCore;
    const memory = { fetchUnifiedMemory: async () => ({ workLogs: [], knowledge: [] }), saveBatchMemory: vi.fn(async () => {}) };
    const exec = vi.fn(async (command: string) => {
      if (!command.includes('PWD:$(pwd)')) agent.agentAbort('connection_closed');
      return { stdout: 'Listening on port 8080', stderr: '', exitCode: 0 };
    });
    const created = setup({ exec, memory }); agent = created.agent;
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      if (!body.stream) return new Response(JSON.stringify(responseObject('memory', JSON.stringify({ workLog: { mode: 'create', title: '检查端口', summary: '执行已中断，需核查状态' }, knowledge: [{ action: 'set', category: 'config', key: 'service_port', value: '8080' }] }), [], body)));
      return reply('resp_1', '', [functionCall()], body);
    });
    await agent.handleAgentStart('1', '检查端口');
    await Promise.all(created.waits);
    expect(memory.saveBatchMemory).toHaveBeenCalledWith(expect.objectContaining({ workLog: expect.objectContaining({ title: '[已中断] 检查端口' }) }));
    expect(requests[1]).toMatchObject({ store: false, stream: false, text: { format: { name: 'server_memory' } } });
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    expect(requests[1]).not.toHaveProperty('tools');
  });

  it('TerminalContext snapshots remain bounded and preserve the tail', () => {
    const terminal = new TerminalContext();
    terminal.appendOutput('x'.repeat(25_000) + '\nend');
    expect(terminal.snapshot(200).length).toBeLessThan(16_100);
    expect(terminal.snapshot(200, 1000).endsWith('end')).toBe(true);
  });
});
