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
});
