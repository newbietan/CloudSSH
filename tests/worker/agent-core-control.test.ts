import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../src/worker/agent/core';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { aiConfig, functionCall, reply } from './agent/responses-fixtures';

vi.mock('../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));

function setup(exec?: (command: string, timeout: number, signal?: AbortSignal) => Promise<any>, config = async () => aiConfig) {
  const frames: any[] = [];
  const command = vi.fn(exec || (async () => ({ stdout: 'Linux', stderr: '', exitCode: 0 })));
  const agent = new AgentCore(new TerminalContext(), frame => frames.push(frame), config, command, async () => true);
  return { agent, frames, command };
}
afterEach(() => vi.restoreAllMocks());

describe('Responses task control', () => {
  it.each(['zh-CN', 'zh-TW', 'en-US'] as const)('stops and closes every call before continuing (%s)', async locale => {
    let agent: AgentCore;
    const created = setup(async command => {
      if (!command.includes('PWD:$(pwd)')) agent.agentAbort('user_stopped');
      return { stdout: 'partial', stderr: '', exitCode: 0 };
    }); agent = created.agent;
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return requests.length === 1 ? reply('resp_1', '', [functionCall('one'), functionCall('two')], body)
        : reply('resp_2', '继续前先核查状态', [], body);
    });
    await agent.handleAgentStart('1', '开始', locale);
    expect(created.frames.find(frame => frame.messageKey === 'agent.stopped')).toBeDefined();
    expect(created.frames.at(-1)).toMatchObject({ subType: 'run_end', outcome: 'stopped' });
    await agent.handleAgentStart('1', '不要重复执行，只检查状态', locale);
    const outputs = requests[1].input.filter((item: any) => item.type === 'function_call_output');
    expect(outputs.map((item: any) => item.call_id)).toEqual(['one', 'two']);
    expect(JSON.parse(outputs[0].output).status).toBe('unknown');
    expect(JSON.parse(outputs[1].output).status).toBe('cancelled');
    expect(created.command).toHaveBeenCalledTimes(2); // initial environment + only the first call
  });

  it('resets local history/cache key and detects environment again', async () => {
    const { agent, command } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return reply(`resp_${requests.length}`, '完成', [], body);
    });
    await agent.handleAgentStart('1', '第一轮');
    await agent.handleAgentStart('1', '第二轮');
    expect(command).toHaveBeenCalledTimes(1);
    expect(requests[1].input).toContainEqual({ role: 'user', content: '第一轮' });
    agent.resetSession();
    expect((agent as any).context.pending).toEqual([]);
    expect((agent as any).context.history).toEqual([]);
    await agent.handleAgentStart('1', '新会话');
    expect(command).toHaveBeenCalledTimes(2);
    expect(requests[2]).not.toHaveProperty('previous_response_id');
    expect(requests[2].prompt_cache_key).not.toBe(requests[0].prompt_cache_key);
  });

  it('edits a user turn by branching from its local starting history, not later state', async () => {
    const { agent } = setup();
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return reply(`resp_${requests.length}`, '完成', [], body);
    });
    await agent.handleAgentStart('1', '第一轮');
    await agent.handleAgentStart('1', '第二轮');
    await agent.handleAgentStart('1', '修改第二轮', 'zh-CN', undefined, 1);
    expect(requests[2].input).toContainEqual(expect.objectContaining({ id: 'msg_resp_1' }));
    expect(requests[2]).not.toHaveProperty('previous_response_id');
    expect(requests[2].input.some((item: any) => item.content === '第二轮')).toBe(false);
    expect(JSON.stringify(requests[2].input)).toContain('does not undo remote operations');
    await agent.handleAgentStart('1', '修改第一轮', 'zh-CN', undefined, 0);
    expect(requests[3]).not.toHaveProperty('previous_response_id');
    expect(JSON.stringify(requests[3].input)).not.toContain('修改第二轮');
  });

  it('rejects invalid historical indices without changing local history', async () => {
    const { agent, frames } = setup();
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply('resp_1'));
    await agent.handleAgentStart('1', '开始');
    await agent.handleAgentStart('1', '编辑', 'zh-CN', undefined, 999);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((agent as any).context.history).toContainEqual(expect.objectContaining({ id: 'msg_resp_1' }));
    expect(frames.find(frame => frame.code === 'responses_history')).toBeDefined();
  });

  it('does not forward local history or stored credentials after configuration changes', async () => {
    let config = aiConfig;
    const { agent, frames } = setup(undefined, async () => config);
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => reply('resp_1', '完成', [], JSON.parse(init?.body as string)));
    await agent.handleAgentStart('1', '开始');
    config = { ...aiConfig, base_url: 'https://another.example/v1', api_key: 'new-key' };
    await agent.handleAgentStart('1', '继续');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(frames.find(frame => frame.code === 'responses_config_changed')).toBeDefined();
    agent.resetSession();
    await agent.handleAgentStart('1', '新会话');
    expect(mock).toHaveBeenLastCalledWith('https://another.example/v1/responses', expect.anything());
  });

  it('drains a superseded command before replacement execution and suppresses stale frames', async () => {
    let started!: () => void;
    const executing = new Promise<void>(resolve => { started = resolve; });
    let active = 0;
    const created = setup(async (command, _timeout, signal) => {
      if (command.includes('PWD:$(pwd)')) return { stdout: 'Linux', stderr: '', exitCode: 0 };
      active++;
      expect(active).toBe(1);
      started();
      try {
        await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
        return { stdout: 'done', stderr: '', exitCode: 0 };
      } finally { active--; }
    });
    const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string); requests.push(body);
      return requests.length === 1 ? reply('resp_1', '', [functionCall()], body) : reply('resp_2', '新任务完成', [], body);
    });
    const old = created.agent.handleAgentStart('1', '旧任务');
    await executing;
    const replacement = created.agent.handleAgentStart('1', '新任务');
    await Promise.all([old, replacement]);
    expect(active).toBe(0);
    expect(requests[1].input).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_1' }));
    expect(JSON.parse(requests[1].input.find((item: any) => item.type === 'function_call_output').output).status).toBe('unknown');
    expect(created.frames.filter(frame => frame.subType === 'run_end')).toEqual([expect.objectContaining({ runId: 2, outcome: 'completed' })]);
  });

  it('reset during config loading prevents late initialization/output', async () => {
    let resolveConfig!: (value: typeof aiConfig) => void;
    const loading = new Promise<typeof aiConfig>(resolve => { resolveConfig = resolve; });
    const { agent, command, frames } = setup(undefined, async () => loading);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const pending = agent.handleAgentStart('1', '开始');
    agent.resetSession();
    resolveConfig(aiConfig);
    await pending;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect((agent as any).context.history).toEqual([]);
    expect(frames.filter(frame => frame.subType === 'run_end')).toEqual([]);
  });
});
