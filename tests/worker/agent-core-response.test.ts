import { describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../src/worker/agent/core';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import type { AIConfig } from '../../src/worker/agent/types';

function createMockSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('AgentCore 响应交付与循环终止机制', () => {
  const dummyAIConfig: AIConfig = {
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    api_key: 'test-key',
  };

  it('当大模型直接以纯文本回复（无 tool_calls）时，必须向前端发送响应帧', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const execCommand = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    // Mock fetch: 返回纯文本 SSE 流
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"这是直接给出的"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"分析报告。"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        return createMockSSEResponse(sseBody);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', '请分析服务器状态', 'zh-CN');

      expect(agent.getStatus()).toBe('idle');
      // 必须包含 stream_chunk 或 stream_end / response 交付
      const hasResponseOrStreamEnd = frontendFrames.some(
        (f) =>
          (f.subType === 'stream_end' && f.content.includes('分析报告')) ||
          (f.subType === 'response' && f.content.includes('分析报告'))
      );
      expect(hasResponseOrStreamEnd).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('当流式响应中包含空 tool_calls: [] 时，不应误判为工具调用而丢弃文本输出', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const execCommand = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    // 很多 API 代理（如 LiteLLM / OneAPI）会携带 tool_calls: []
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"内存占用正常。","tool_calls":[]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        return createMockSSEResponse(sseBody);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', '查看内存', 'zh-CN');

      expect(agent.getStatus()).toBe('idle');
      const streamEndFrame = frontendFrames.find((f) => f.subType === 'stream_end');
      expect(streamEndFrame).toBeDefined();
      expect(streamEndFrame.content).toContain('内存占用正常');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('多步任务：先调用 execute_command，下一轮直接自然语言总结时，可靠输出总结并正常结束', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const execCommand = vi.fn(async () => ({
      stdout: 'Mem: 16G total, 4G used',
      stderr: '',
      exitCode: 0,
    }));
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    let round = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        round++;
        if (round === 1) {
          // 第 1 轮：发起 execute_command 工具调用
          return createMockSSEResponse([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"execute_command","arguments":"{\\"command\\":\\"free -m\\"}"}}]}}]}\n\n',
            'data: [DONE]\n\n',
          ]);
        } else {
          // 第 2 轮：拿到输出后直接给出总结
          return createMockSSEResponse([
            'data: {"choices":[{"delta":{"content":"系统总内存 16G，已使用 4G，负载正常。"}}]}\n\n',
            'data: [DONE]\n\n',
          ]);
        }
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', '检查内存', 'zh-CN');

      expect(execCommand).toHaveBeenCalledWith('free -m', 10000, expect.any(Object));
      expect(agent.getStatus()).toBe('idle');

      // 验证第 1 轮发出了 executing
      const execFrame = frontendFrames.find(
        (f) => f.subType === 'executing' && f.tool === 'execute_command'
      );
      expect(execFrame).toBeDefined();

      // 验证第 2 轮成功发出了总结报告
      const hasFinalSummary = frontendFrames.some(
        (f) =>
          (f.subType === 'stream_end' && f.content.includes('已使用 4G')) ||
          (f.subType === 'response' && f.content.includes('已使用 4G'))
      );
      expect(hasFinalSummary).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('极端异常：大模型返回空 content 且未调用工具时，提供兜底完成消息', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const execCommand = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    // Mock 空响应
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        return createMockSSEResponse([
          'data: {"choices":[{"delta":{"content":""}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', '测试空响应', 'zh-CN');

      expect(agent.getStatus()).toBe('idle');
      const responseFrame = frontendFrames.find(
        (f) => f.subType === 'response' && f.content === '任务已执行完成。'
      );
      expect(responseFrame).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('TerminalContext.snapshot 限制行数并对超长字符执行截断留痕', () => {
    const ctx = new TerminalContext();
    ctx.appendOutput('line1\nline2\nline3');
    expect(ctx.snapshot(2)).toBe('line2\nline3');

    const hugeLine = 'x'.repeat(10_000);
    ctx.clear();
    ctx.appendOutput(`${hugeLine}\nend\n`);
    const snap = ctx.snapshot(200, 1000);
    expect(snap.length).toBeLessThan(1100);
    expect(snap).toContain('终端前序输出已省略');
    expect(snap.endsWith('end')).toBe(true);

    ctx.clear();
    ctx.appendOutput('y'.repeat(25_000));
    const defaultSnap = ctx.snapshot(200);
    expect(defaultSnap.length).toBeLessThan(16_100);
    expect(defaultSnap).toContain('终端前序输出已省略');
  });

  it('单轮长任务在工具消息累积时对更早的 tool 输出执行轻量压缩并保留配对', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    // 每次命令执行返回超长输出（1000 字符）
    const execCommand = vi.fn(async () => ({
      stdout: 'LogOutputStart_' + 'x'.repeat(1000) + '_LogOutputEnd',
      stderr: '',
      exitCode: 0,
    }));
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    let step = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        step++;
        if (step <= 8) {
          // 前 8 步持续调用工具
          return createMockSSEResponse([
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_${step}","type":"function","function":{"name":"execute_command","arguments":"{\\"command\\":\\"ls -l ${step}\\"}"}}]}}]}\n\n`,
            'data: [DONE]\n\n',
          ]);
        } else {
          // 第 9 步直接返回总结
          return createMockSSEResponse([
            'data: {"choices":[{"delta":{"content":"多步长任务已全部排查完毕。"}}]}\n\n',
            'data: [DONE]\n\n',
          ]);
        }
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', '执行连续排查长任务', 'zh-CN');

      expect(agent.getStatus()).toBe('idle');
      // 检查内部消息历史（通过私有属性断言）
      const messages = (agent as any).state.messages;
      const toolMsgs = messages.filter((m: any) => m.role === 'tool');
      expect(toolMsgs.length).toBe(8);

      // 最早的 2 次工具消息（call_1, call_2）应被压缩
      expect(toolMsgs[0].content).toContain('更早历史执行输出已压缩');
      expect(toolMsgs[1].content).toContain('更早历史执行输出已压缩');

      // 最近 6 次工具消息（call_3 ~ call_8）应保持完整未压缩
      expect(toolMsgs[2].content).not.toContain('更早历史执行输出已压缩');
      expect(toolMsgs[7].content).not.toContain('更早历史执行输出已压缩');
      expect(toolMsgs[7].content).toContain('_LogOutputEnd');

      // 确保所有 tool_call_id 与前面 assistant 依然严格配对
      for (let i = 0; i < 8; i++) {
        expect(toolMsgs[i].tool_call_id).toBe(`call_${i + 1}`);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('当会话因断网/关闭连接中止且已执行实质性命令时，触发中断保护性提炼并通过 waitUntil 挂载', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const execCommand = vi.fn(async (cmd: string) => {
      if (cmd.includes('PWD:$(pwd)')) {
        return { stdout: 'Linux', stderr: '', exitCode: 0 };
      }
      // 模拟工具执行期间遭遇网络断开 / 会话关闭
      agent.agentAbort('connection_closed');
      return {
        stdout: 'Listening on port 8080',
        stderr: '',
        exitCode: 0,
      };
    });
    const askConfirmation = vi.fn(async () => true);

    const savedBatches: any[] = [];
    const memoryProvider = {
      fetchUnifiedMemory: async () => ({ workLogs: [], knowledge: [] }),
      saveBatchMemory: async (batch: any) => {
        savedBatches.push(batch);
      },
    };

    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    });

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation,
      undefined,
      memoryProvider,
      waitUntil
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('chat/completions')) {
        const bodyStr = init?.body ? JSON.parse(init.body) : {};
        // 判断是否为提炼请求（system prompt 包含 MEMORY_DISTILLATION_PROMPT 关键字）
        const isDistill =
          bodyStr.messages?.[0]?.content?.includes('服务器智能会话总结助手') ||
          bodyStr.messages?.[0]?.content?.includes('Server Memory Distillation');
        if (isDistill) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      workLog: {
                        mode: 'create',
                        title: '检查服务监听端口',
                        summary: '服务在 8080 端口正常监听',
                      },
                      knowledge: [
                        { category: 'config', key: 'service_port', value: '8080' },
                      ],
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return createMockSSEResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"execute_command","arguments":"{\\"command\\":\\"netstat -tlpn\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', '请排查端口', 'zh-CN');

      expect(agent.getStatus()).toBe('idle');
      // 必须调用了 waitUntil 注册提炼 Promise
      expect(waitUntil).toHaveBeenCalled();
      await Promise.all(waitUntilPromises);

      // 验证保存的批次中包含 [已中断] 标签与知识
      expect(savedBatches.length).toBeGreaterThan(0);
      const saved = savedBatches[0];
      expect(saved.workLog.title).toContain('[已中断]');
      expect(saved.knowledge).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'service_port', value: '8080' }),
        ])
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
