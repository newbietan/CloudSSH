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

describe('AgentCore 任务停止、抢占与会话重置控制机制', () => {
  const dummyAIConfig: AIConfig = {
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    api_key: 'test-key',
  };

  it('用户手动停止任务时（agentAbort("user_stopped")），准确推送中文手动停止文案而非超时', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const execCommand = vi.fn(async (_cmd: string, _timeout: number, signal?: AbortSignal) => {
      // 模拟执行长时间命令时，用户在前端点击了 Stop
      agent.agentAbort('user_stopped');
      if (signal?.aborted) {
        throw new Error('Command aborted');
      }
      return { stdout: 'done', stderr: '', exitCode: 0 };
    });
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        return createMockSSEResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"execute_command","arguments":"{\\"command\\":\\"sleep 10\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', '测试停止', 'zh-CN');

      expect(agent.getStatus()).toBe('idle');
      const responseFrame = frontendFrames.find(
        (f) => f.subType === 'response' && f.content.includes('Agent 任务已由用户手动停止。')
      );
      expect(responseFrame).toBeDefined();
      expect(responseFrame.content).not.toContain('执行超时');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('英文环境下手动停止任务时，准确推送英文停止文案', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const execCommand = vi.fn(async () => {
      agent.agentAbort('user_stopped');
      return { stdout: 'done', stderr: '', exitCode: 0 };
    });
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        return createMockSSEResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"execute_command","arguments":"{\\"command\\":\\"tail -f /var/log/syslog\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      await agent.handleAgentStart('user-1', 'Tail syslog', 'en-US');

      expect(agent.getStatus()).toBe('idle');
      const responseFrame = frontendFrames.find(
        (f) => f.subType === 'response' && f.content === 'Agent task stopped by user.'
      );
      expect(responseFrame).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('未完成任务时新发起请求（抢占式中止 superseded），不发送超时或错误提示，新任务顺利执行', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    let commandCount = 0;
    const execCommand = vi.fn(async () => {
      commandCount++;
      return { stdout: `Output ${commandCount}`, stderr: '', exitCode: 0 };
    });
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        callCount++;
        return createMockSSEResponse([
          `data: {"choices":[{"delta":{"content":"第 ${callCount} 次响应成功。"}},{"finish_reason":"stop"}]}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      // 模拟先启动第 1 个任务（故意让状态变为 running）
      (agent as any).state.status = 'running';

      // 启动新任务（supersede 抢占）
      await agent.handleAgentStart('user-1', '抢占发起的新任务', 'zh-CN');

      expect(agent.getStatus()).toBe('idle');
      // 确保没有发送超时提醒
      const timeoutFrame = frontendFrames.find(
        (f) => f.subType === 'response' && f.content.includes('执行超时')
      );
      expect(timeoutFrame).toBeUndefined();

      // 确保新任务正常生成了回复（stream_end 或 response）
      const newResponse = frontendFrames.find(
        (f) =>
          (f.subType === 'stream_end' || f.subType === 'response') &&
          f.content?.includes('第 1 次响应成功')
      );
      expect(newResponse).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('resetSession() 彻底清空历史消息与状态，下一轮提问作为崭新会话重新检测环境', async () => {
    const frontendFrames: any[] = [];
    const terminalContext = new TerminalContext();
    const sendToFrontend = (msg: any) => frontendFrames.push(msg);
    const fetchAIConfig = async () => dummyAIConfig;
    const detectedEnvs: string[] = [];
    const execCommand = vi.fn(async (cmd: string) => {
      if (cmd.includes('PWD:$(pwd)')) {
        detectedEnvs.push(cmd);
        return { stdout: 'Linux Ubuntu 22.04', stderr: '', exitCode: 0 };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    const askConfirmation = vi.fn(async () => true);

    const agent = new AgentCore(
      terminalContext,
      sendToFrontend,
      fetchAIConfig,
      execCommand,
      askConfirmation
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        return createMockSSEResponse([
          'data: {"choices":[{"delta":{"content":"完成。"}},{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      // 轮次 1：首次会话，触发环境探测
      await agent.handleAgentStart('user-1', '第一次提问', 'zh-CN');
      expect(detectedEnvs.length).toBe(1);

      // 轮次 2：后续提问（未重置），不重新探测环境
      await agent.handleAgentStart('user-1', '第二次提问', 'zh-CN');
      expect(detectedEnvs.length).toBe(1);

      // 执行重置
      agent.resetSession();
      expect(agent.getStatus()).toBe('idle');
      expect((agent as any).state.messages).toHaveLength(0);
      expect((agent as any).state.iteration).toBe(0);

      // 轮次 3：重置后提问，必须重新触发首次环境探测
      await agent.handleAgentStart('user-1', '重置后新话题', 'zh-CN');
      expect(detectedEnvs.length).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('handleAgentStart 携带 userIndex 支持原地编辑重发并截断其后所有历史轮次', async () => {
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

    let roundCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('chat/completions')) {
        roundCount++;
        return createMockSSEResponse([
          `data: {"choices":[{"delta":{"content":"回复轮次 ${roundCount}。"}},{"finish_reason":"stop"}]}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return new Response('{}', { status: 200 });
    });

    try {
      // 轮次 1：第 0 条用户消息
      await agent.handleAgentStart('user-1', '第一条消息：查内存', 'zh-CN');
      expect((agent as any).state.messages).toHaveLength(3); // system + user1 + assistant1

      // 轮次 2：第 1 条用户消息
      await agent.handleAgentStart('user-1', '第二条消息：查网络', 'zh-CN');
      expect((agent as any).state.messages).toHaveLength(5); // system + user1 + assistant1 + user2 + assistant2
      const messagesBeforeEdit = (agent as any).state.messages;
      expect(messagesBeforeEdit.some((m: any) => m.content === '第二条消息：查网络')).toBe(true);

      // 轮次 3：用户原地编辑第 0 条消息为 "第一条消息修改：查CPU"，并传入 userIndex: 0
      await agent.handleAgentStart(
        'user-1',
        '第一条消息修改：查CPU',
        'zh-CN',
        undefined,
        0 // userIndex: 0
      );

      const messagesAfterEdit = (agent as any).state.messages;
      // 验证第 1 条及其之后的消息已被截断丢弃，仅保留 system + user1_new + assistant3
      expect(messagesAfterEdit).toHaveLength(3);
      expect(messagesAfterEdit.some((m: any) => m.content === '第二条消息：查网络')).toBe(false);
      expect(messagesAfterEdit.some((m: any) => m.content === '第一条消息修改：查CPU')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
