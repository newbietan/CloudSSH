import { describe, expect, it, vi } from 'vitest';
import { TerminalContext } from '../../src/worker/agent/terminal-context';
import { ToolExecutor } from '../../src/worker/agent/tool-executor';

// =====================================================================
// tool-executor.test.ts
// ---------------------------------------------------------------
// Agent 工具层的输出有界化回归：
//   1. docker_manage(logs) 必须是有界查看 —— 拒绝无限流式 -f/--follow，
//      未显式指定 --tail 时强制追加 --tail 200。
//   2. 所有 exec 类工具结果在进入 LLM 上下文前做 head/tail 截断，
//      防止大输出把后续每轮 LLM 请求体撑爆（弱网环境下的核心诱因）。
// =====================================================================

function makeExecutor(execResult: {
  stdout: string;
  stderr: string;
  exitCode: number;
}) {
  const execCommand = vi.fn(
    async (command: string): Promise<typeof execResult> => execResult
  );
  const askConfirmation = vi.fn(async () => true);
  const executor = new ToolExecutor(
    new TerminalContext(),
    execCommand,
    askConfirmation,
    undefined
  );
  return { executor, execCommand, askConfirmation };
}

describe('docker_manage(logs) — 日志查看必须是有界的', () => {
  it('未指定 --tail 时强制追加 --tail 200', async () => {
    const { executor, execCommand } = makeExecutor({ stdout: 'ok', stderr: '', exitCode: 0 });
    const result = await executor.execute(
      'docker_manage',
      { action: 'logs', target: 'blog-backend' },
      undefined
    );
    expect(execCommand).toHaveBeenCalledOnce();
    expect(execCommand.mock.calls[0][0]).toBe('docker logs --tail 200 blog-backend');
    expect(JSON.parse(result).exit_code).toBe(0);
  });

  it('带其它选项（如 --since）时同样补齐 --tail', async () => {
    const { executor, execCommand } = makeExecutor({ stdout: '', stderr: '', exitCode: 0 });
    await executor.execute(
      'docker_manage',
      { action: 'logs', target: 'blog-backend', options: '--since 24h' },
      undefined
    );
    expect(execCommand.mock.calls[0][0]).toBe('docker logs --since 24h --tail 200 blog-backend');
  });

  it('已显式携带 --tail 时不重复追加', async () => {
    const { executor, execCommand } = makeExecutor({ stdout: '', stderr: '', exitCode: 0 });
    await executor.execute(
      'docker_manage',
      { action: 'logs', target: 'blog-backend', options: '--tail 500' },
      undefined
    );
    expect(execCommand.mock.calls[0][0]).toBe('docker logs --tail 500 blog-backend');
  });

  it('拒绝无限流式 -f / --follow：不执行任何命令并返回明确错误', async () => {
    for (const options of ['-f', '--follow', '-f --tail 10', '--tail 10 --follow']) {
      const { executor, execCommand } = makeExecutor({ stdout: '', stderr: '', exitCode: 0 });
      const result = await executor.execute(
        'docker_manage',
        { action: 'logs', target: 'blog-backend', options },
        undefined
      );
      expect(execCommand).not.toHaveBeenCalled();
      const parsed = JSON.parse(result);
      expect(parsed.blocked).toBe(true);
      expect(parsed.stderr).toContain('不允许');
    }
  });

  it('含 shell 元字符的 options 会被净化后照常强制 --tail', async () => {
    const { executor, execCommand } = makeExecutor({ stdout: '', stderr: '', exitCode: 0 });
    await executor.execute(
      'docker_manage',
      { action: 'logs', target: 'blog-backend', options: '--tail 5; rm -rf /' },
      undefined
    );
    expect(execCommand.mock.calls[0][0]).toBe('docker logs --tail 200 blog-backend');
  });
});

describe('工具结果进 LLM 前截断 — token budgeting', () => {
  it('小输出原样返回，不带截断标记', async () => {
    const { executor } = makeExecutor({ stdout: 'short output', stderr: '', exitCode: 0 });
    const result = await executor.execute(
      'execute_command',
      { command: 'echo short', timeout_ms: 5000 },
      undefined
    );
    const parsed = JSON.parse(result);
    expect(parsed.stdout).toBe('short output');
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.exit_code).toBe(0);
  });

  it('大输出（200KB）截断到 64K 字符预算内，保留头尾并附省略计数', async () => {
    const big = 'x'.repeat(200 * 1024);
    const { executor } = makeExecutor({ stdout: big, stderr: '', exitCode: 0 });
    const result = await executor.execute(
      'execute_command',
      { command: 'cat big.log', timeout_ms: 5000 },
      undefined
    );
    const parsed = JSON.parse(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.omitted_chars).toBeGreaterThan(0);
    // 头部与尾部内容都保留
    expect(parsed.stdout.startsWith('xxx')).toBe(true);
    expect(parsed.stdout.endsWith('xxx')).toBe(true);
    expect(parsed.stdout).toContain('输出过长已截断');
    // 总长度受控（64K 预算 + 截断说明）
    expect(parsed.stdout.length).toBeLessThan(70_000);
  });
});