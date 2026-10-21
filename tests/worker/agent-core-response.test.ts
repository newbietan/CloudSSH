import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../src/worker/agent/core';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { aiConfig, functionCall, reply, responseObject, sse } from './agent/responses-fixtures';

// Protocol fixtures stub DNS; the real outbound guard is covered in responses-ssrf.test.ts.
vi.mock('../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));

function setup(options: any = {}) {
  const frames: any[] = [];
  const terminal = new TerminalContext();
  const exec = vi.fn(async () => ({ stdout: 'Linux', stderr: '', exitCode: 0 }));
  const waits: Promise<unknown>[] = [];
  const agent = new AgentCore(terminal, frame => frames.push(frame), async () => options.aiConfig || aiConfig,
    options.exec || exec, async () => true, options.config, options.memory, promise => waits.push(promise));
  return { agent, frames, terminal, exec, waits };
}
function seedOlderHistory(agent: AgentCore) {
  const context = (agent as any).context;
  for (let i = 0; i < 4; i++) {
    context.beginTurn(`Earlier request ${i}`);
    context.accept({ ...responseObject(`old_${i}`, 'Earlier observation'), text: 'Earlier observation', calls: [] }, context.buildInput());
  }
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

  it('replays complete native history statelessly while keeping instructions/tools stable', async () => {
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
    expect(requests.every(body => body.store === false && !('previous_response_id' in body))).toBe(true);
    expect(requests[1].input.slice(0, requests[0].input.length)).toEqual(requests[0].input);
    expect(requests[1].input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_1' }));
    expect(requests[1].input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }));
    expect(requests[1].input.filter((item: any) => item.content?.includes?.('terminal unchanged'))).toHaveLength(1);
    expect(requests[1].instructions).toBe(requests[0].instructions);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].prompt_cache_key).toBe(requests[0].prompt_cache_key);
    expect(requests[0].instructions).not.toContain('terminal unchanged');
  });

  it('replays opaque reasoning and assistant phases across tool and user turns without putting them in saved conversation text', async () => {
    const { agent, frames, exec } = setup();
    const requests: any[] = [];
    const reasoning = { type: 'reasoning', id: 'rs_native', summary: [], status: 'completed',
      encrypted_content: 'OPAQUE_STATE', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING' }] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      const response: any = responseObject(`resp_${requests.length}`, 'Visible', requests.length === 1 ? [functionCall()] : []);
      response.output.at(-1).phase = requests.length === 1 ? 'commentary' : 'final_answer';
      if (requests.length === 1) response.output.unshift(reasoning);
      return sse([{ type: 'response.completed', response }]);
    });
    await agent.handleAgentStart('1', 'Inspect');
    await agent.handleAgentStart('1', 'Explain');
    expect(requests).toHaveLength(3);
    expect(requests[1].input).toContainEqual(reasoning);
    expect(requests[2].input).toContainEqual(reasoning);
    expect(requests[1].input).toContainEqual(expect.objectContaining({ phase: 'commentary' }));
    expect(requests[2].input).toContainEqual(expect.objectContaining({ phase: 'final_answer' }));
    expect(exec).toHaveBeenCalledTimes(2); // one environment probe and one actual command
    expect(JSON.stringify(frames)).not.toMatch(/OPAQUE_STATE|PRIVATE_REASONING/);
    expect((agent as any).context.formatItemsForCompaction()).not.toMatch(/OPAQUE_STATE|PRIVATE_REASONING/);
  });

  it('applies model budgets and requires a fresh chat when they change', async () => {
    const config = { ...aiConfig, context_window: 32_768, max_output_tokens: 2048 };
    const { agent, frames } = setup({ aiConfig: config });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('resp_budget'));
    await agent.handleAgentStart('1', 'Inspect');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).max_output_tokens).toBe(2048);
    config.max_output_tokens = 1024;
    await agent.handleAgentStart('1', 'Again');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(frames.find(frame => frame.code === 'responses_config_changed')).toBeTruthy();
  });

  it('compacts with summarization at budget boundary and preserves tool history on continuation error', async () => {
    const { agent, frames } = setup();
    seedOlderHistory(agent);
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests++;
      const body = JSON.parse(init!.body as string);
      if (!body.stream) return Response.json(responseObject('resp_cp', 'Summary.'));
      if (requests === 3) return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
      const response = responseObject('resp_first', '', [functionCall()]);
      response.usage.input_tokens = 55_000;
      return sse([{ type: 'response.completed', response }]);
    });
    await agent.handleAgentStart('1', 'Inspect');
    expect(requests).toBe(3);
    expect(frames.find(frame => frame.subType === 'error')?.code).toBe('responses_http');
    expect(JSON.stringify((agent as any).context.buildInput())).toContain('Summary.');
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
    expect(requests[1].input.some((item: any) => item.content === '第一轮')).toBe(true);
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
    expect(requests[2].input).toContainEqual(expect.objectContaining({ id: 'msg_resp_1' }));
    expect(requests[2].input.some((item: any) => item.id === 'msg_resp_2')).toBe(false);
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
    const result = JSON.parse(requests[1].input.find((item: any) => item.type === 'function_call_output').output);
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
    expect((agent as any).context.history).toEqual([]);
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
    const results = requests[1].input.filter((item: any) => item.type === 'function_call_output').map((item: any) => JSON.parse(item.output));
    expect(results[0].status).toBe('invalid_arguments');
    expect(results[1].blocked).toBe(true);
  });

  it('keeps all tool results immutable in local native replay history', async () => {
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
    const first = requests[1].input.find((item: any) => item.type === 'function_call_output');
    for (const body of requests.slice(1)) {
      expect(body.input.find((item: any) => item.type === 'function_call_output')).toEqual(first);
      expect(first.output).toContain('tail');
    }
    expect(requests.at(-1).input.filter((item: any) => item.type === 'function_call_output')).toHaveLength(8);
  });

  it('uses application-level compaction at the budget boundary without orphan outputs', async () => {
    const { agent } = setup();
    seedOlderHistory(agent);
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      if (!body.stream) return Response.json(responseObject('resp_cp', 'Nginx inspected.'));
      if (requests.length === 1) {
        const response = responseObject('resp_1', '', [functionCall()], body);
        response.usage.input_tokens = 55_000; response.usage.total_tokens = 55_020;
        return sse([{ type: 'response.completed', response }]);
      }
      return reply('resp_after', '检查完成', [], body);
    });
    await agent.handleAgentStart('1', '检查 nginx');
    expect(requests).toHaveLength(3);
    expect(requests[1].instructions).toContain('紧凑总结');
    expect(requests[1].stream).toBe(false);
    expect(requests[1].max_output_tokens).toBe(1500);
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    expect(requests[2]).not.toHaveProperty('previous_response_id');
    const calls = requests[2].input.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id);
    const outputs = requests[2].input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id);
    expect(outputs).toEqual(calls);
    expect(outputs).toContain('call_1');
    expect(JSON.stringify(requests[2].input)).toContain('Nginx inspected.');
  });

  it('submits interrupted conversation for background summarization without a separate evidence journal', async () => {
    let agent: AgentCore;
    const memory = { fetchUnifiedMemory: async () => ({ workLogs: [], knowledge: [], revision: 0 }),
      enqueueMemory: vi.fn(async (_task: unknown) => {}) };
    const exec = vi.fn(async (command: string) => {
      if (!command.includes('PWD:$(pwd)')) agent.agentAbort('connection_closed');
      return { stdout: 'Listening on port 8080', stderr: '', exitCode: 0 };
    });
    const created = setup({ exec, memory }); agent = created.agent;
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('inspect', '', [functionCall()]));
    await agent.handleAgentStart('1', '检查端口'); await Promise.all(created.waits);
    expect(memory.enqueueMemory).toHaveBeenCalledTimes(1);
    expect(memory.enqueueMemory.mock.calls[0][0]).toMatchObject({ goal: '检查端口', conversation: expect.stringContaining('8080') });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('provides a previously saved full key to a later deployment task without relevance filtering', async () => {
    const key = 'deployment-secret-' + 'X'.repeat(1000);
    const priorKeys = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, user_id: 1, server_id: 1,
      category: 'credential', key: `other_key_${i}`, value: 'K'.repeat(15_000), created_at: 1, updated_at: 1 }));
    const memory = { fetchUnifiedMemory: async () => ({ revision: 1, workLogs: [], knowledge: [...priorKeys, { id: 5, user_id: 1, server_id: 1,
      category: 'credential', key: 'service_api_key', value: key, created_at: 1, updated_at: 1 }] }), enqueueMemory: vi.fn(async () => {}) };
    const { agent, waits } = setup({ memory });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('done', 'Deployment completed.'));
    await agent.handleAgentStart('1', '部署服务'); await Promise.all(waits);
    expect(String(fetch.mock.calls[0][1]?.body)).toContain(key);
    expect(memory.enqueueMemory).toHaveBeenCalledTimes(1);
  });

  it('auto-stitches incomplete response with partial text and seamlessly finishes', async () => {
    const { agent, frames } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      requests.push(body);
      if (requests.length === 1) {
        return sse([
          { type: 'response.output_text.delta', delta: '第一段很长的推导分析内容...' },
          {
            type: 'response.incomplete',
            response: {
              ...responseObject('resp_1', '第一段很长的推导分析内容...', []),
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
            },
          },
        ]);
      }
      return reply('resp_2', '第二段内容并得出最终结论。', [], body);
    });

    await agent.handleAgentStart('1', '长任务测试');
    expect(agent.getStatus()).toBe('idle');
    expect(requests).toHaveLength(2);
    expect(requests[1].input.some((item: any) => item.content?.includes('system continuation'))).toBe(true);
    const streamEnd = frames.find(frame => frame.subType === 'stream_end');
    expect(streamEnd?.content).toContain('第一段很长的推导分析内容');
    expect(streamEnd?.content).toContain('第二段内容并得出最终结论');
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'completed' });
  });

  it('fails with responses_incomplete when auto-stitch exceeds maximum attempts', async () => {
    const { agent, frames } = setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return sse([
        { type: 'response.output_text.delta', delta: '未完待续...' },
        {
          type: 'response.incomplete',
          response: {
            ...responseObject('resp_inc', '未完待续...', []),
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          },
        },
      ]);
    });

    await agent.handleAgentStart('1', '无限截断任务');
    expect(frames.find(frame => frame.subType === 'error')?.code).toBe('responses_incomplete');
    expect(frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'failed' });
  });

  it('TerminalContext snapshots remain bounded and preserve the tail', () => {
    const terminal = new TerminalContext();
    terminal.appendOutput('x'.repeat(25_000) + '\nend');
    expect(terminal.snapshot(200).length).toBeLessThan(16_100);
    expect(terminal.snapshot(200, 1000).endsWith('end')).toBe(true);
  });
});
