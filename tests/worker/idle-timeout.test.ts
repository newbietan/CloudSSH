import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  MIN_IDLE_TIMEOUT_MS,
  parseIdleTimeout,
} from '../../src/worker/idle-timeout';
import { SSHSession } from '../../src/worker/ssh-session';

describe('parseIdleTimeout', () => {
  it('未设置或空值回退到默认 30 分钟', () => {
    expect(parseIdleTimeout(undefined)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeout(null)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeout('')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeout('   ')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('显式设置 0、false、none、off 时禁用空闲超时 (返回 0)', () => {
    expect(parseIdleTimeout('0')).toBe(0);
    expect(parseIdleTimeout('false')).toBe(0);
    expect(parseIdleTimeout('none')).toBe(0);
    expect(parseIdleTimeout('off')).toBe(0);
    expect(parseIdleTimeout('  OFF  ')).toBe(0);
  });

  it('纯数字默认按秒解析', () => {
    expect(parseIdleTimeout('1800')).toBe(1800 * 1000);
    expect(parseIdleTimeout('60')).toBe(60 * 1000);
  });

  it('正确解析分钟 (m / min / mins / minutes)', () => {
    expect(parseIdleTimeout('30m')).toBe(30 * 60 * 1000);
    expect(parseIdleTimeout('15min')).toBe(15 * 60 * 1000);
    expect(parseIdleTimeout('10mins')).toBe(10 * 60 * 1000);
    expect(parseIdleTimeout('45minutes')).toBe(45 * 60 * 1000);
  });

  it('正确解析小时 (h / hr / hrs / hours)', () => {
    expect(parseIdleTimeout('1h')).toBe(3600 * 1000);
    expect(parseIdleTimeout('2hr')).toBe(2 * 3600 * 1000);
    expect(parseIdleTimeout('1.5hours')).toBe(1.5 * 3600 * 1000);
  });

  it('正确解析秒 (s / sec / secs / seconds) 与毫秒 (ms)', () => {
    expect(parseIdleTimeout('120s')).toBe(120 * 1000);
    expect(parseIdleTimeout('300sec')).toBe(300 * 1000);
    expect(parseIdleTimeout('20000ms')).toBe(20000);
  });

  it('小于 10 秒的正数值自动限制为最小保护下限 10 秒', () => {
    expect(parseIdleTimeout('5s')).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeout('1000ms')).toBe(MIN_IDLE_TIMEOUT_MS);
  });

  it('非法格式或负数安全回退到默认 30 分钟', () => {
    expect(parseIdleTimeout('invalid_string')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeout('-30m')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(parseIdleTimeout('abc123')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });
});

describe('SSHSession 空闲超时机制', () => {
  function createTestSession(options?: { idleTimeoutMs?: number; env?: any }) {
    const sent: string[] = [];
    const ws = {
      readyState: 1,
      send: vi.fn((data: string) => sent.push(data)),
      close: vi.fn(),
    };
    const socket = { close: vi.fn() };
    const session = new SSHSession(
      ws as unknown as WebSocket,
      socket as never,
      {
        host: 'target.example.com',
        port: 22,
        username: 'test',
        password: 'pwd',
        authMethod: 'password',
      },
      true,
      false,
      undefined,
      options?.env,
      undefined,
      undefined,
      {
        openShellOnAuth: true,
        ownsWebSocket: true,
        idleTimeoutMs: options?.idleTimeoutMs,
      }
    );
    return { session, ws, socket, sent };
  }

  it('无操作超时后主动向客户端发送 session_idle_timeout 并正常关闭连接', async () => {
    // 设置短超时 60ms 测试
    const { session, ws, sent } = createTestSession({ idleTimeoutMs: 60 });
    (session as any).state = 'ready';
    (session as any).startIdleWatchdog();

    // 等待 150ms 触发超时
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(ws.close).toHaveBeenCalledWith(1000);
    const parsedMessages = sent.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    const timeoutError = parsedMessages.find(
      (m) => m?.type === 'error' && m?.event === 'session_idle_timeout'
    );
    expect(timeoutError).toBeDefined();
    expect(timeoutError.message).toContain('空闲超时');
    session.close(true);
  });

  it('用户终端输入会刷新空闲计时器，避免被误杀', async () => {
    const { session, ws } = createTestSession({ idleTimeoutMs: 100 });
    (session as any).state = 'ready';
    (session as any).startIdleWatchdog();

    const t0 = session.getLastUserActivityAt();

    // 在 50ms 时模拟用户敲击键盘输入
    await new Promise((resolve) => setTimeout(resolve, 50));
    await session.handleWebSocketMessage('ls -la\n');

    expect(session.getLastUserActivityAt()).toBeGreaterThanOrEqual(t0);
    expect(ws.close).not.toHaveBeenCalled();

    session.close(true);
  });

  it('WebSocket ping 心跳不刷新用户活动计时器', async () => {
    const { session } = createTestSession({ idleTimeoutMs: 10000 });
    (session as any).state = 'ready';

    const t0 = session.getLastUserActivityAt();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 客户端发送 ping
    await session.handleWebSocketMessage(JSON.stringify({ type: 'ping', id: 'probe-1' }));

    // lastUserActivityAt 不应该被 ping 更新
    expect(session.getLastUserActivityAt()).toBe(t0);

    session.close(true);
  });

  it('配置为 0 (禁用) 时不会触发空闲超时', async () => {
    const { session, ws } = createTestSession({ idleTimeoutMs: 0 });
    expect(session.getIdleTimeoutMs()).toBe(0);
    (session as any).state = 'ready';
    (session as any).startIdleWatchdog();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.close).not.toHaveBeenCalled();

    session.close(true);
  });

  it('超时前预警：触发 session_idle_warning 并在用户输入后解除预警状态', async () => {
    // 设 idleTimeoutMs = 120ms，warningLeadMs = 40ms (120/3)
    const { session, sent } = createTestSession({ idleTimeoutMs: 120 });
    (session as any).state = 'ready';
    (session as any).startIdleWatchdog();

    // 等待预警触发 (阈值为 120 - 40 = 80ms，轮询等待确保不因定时器调度抖动误报)
    for (let i = 0; i < 15 && !session.isIdleWarningEmitted(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(session.isIdleWarningEmitted()).toBe(true);

    const parsedMessages = sent.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    const warning = parsedMessages.find(
      (m) => m?.type === 'status' && m?.event === 'session_idle_warning'
    );
    expect(warning).toBeDefined();

    // 用户在预警后输入，刷新活跃时间并清除预警标记
    await session.handleWebSocketMessage('echo keepalive\n');
    expect(session.isIdleWarningEmitted()).toBe(false);

    session.close(true);
  });

  it('AI Agent 运行态保护：Agent 工作期间自动维持连接不被超时断开', async () => {
    const { session, ws } = createTestSession({ idleTimeoutMs: 60 });
    (session as any).state = 'ready';

    // Mock agentCore 处于 running 状态
    (session as any).agentCore = {
      getStatus: () => 'running',
      agentAbort: vi.fn(),
    };
    (session as any).startIdleWatchdog();

    // 等待 120ms（超过 60ms 超时）
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(ws.close).not.toHaveBeenCalled();
    session.close(true);
  });
});
