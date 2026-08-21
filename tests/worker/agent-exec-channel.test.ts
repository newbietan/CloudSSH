import { describe, expect, it } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import { AgentExecChannel, MAX_EXEC_CAPTURE_BYTES } from '../../src/worker/agent/exec-channel';

const encoder = new TextEncoder();

function makeChannel() {
  return new AgentExecChannel(7, new SSHChannel());
}

describe('AgentExecChannel — 输出捕获有界化（防止 docker logs 等大输出打爆 DO 内存）', () => {
  it('小输出：完整保留且不截断，onData 持续返回 true（继续续 window）', async () => {
    const ch = makeChannel();
    expect(ch.onData(encoder.encode('hello '))).toBe(true);
    expect(ch.onData(encoder.encode('world\n'))).toBe(true);
    expect(ch.onExtendedData(encoder.encode('warn\n'))).toBe(true);
    ch.onExitStatus(0);
    ch.onClose();

    const result = await ch.getClosedPromise();
    expect(result.stdout).toBe('hello world\n');
    expect(result.stderr).toBe('warn\n');
    expect(result.exitCode).toBe(0);
  });

  it('超大输出：保留头部 128KB 与尾部 256KB，丢弃中间并附加截断说明', async () => {
    const ch = makeChannel();
    const headChunk = encoder.encode('a'.repeat(128 * 1024));
    expect(ch.onData(headChunk)).toBe(true);
    // 尾部灌入 6×64KB=384KB，滚动后仅保留最后 256KB，丢弃 128KB
    const tailChunk = encoder.encode('b'.repeat(64 * 1024));
    for (let i = 0; i < 6; i++) {
      expect(ch.onData(tailChunk)).toBe(true);
    }
    ch.onExitStatus(0);
    ch.onClose();

    const result = await ch.getClosedPromise();
    expect(result.stdout.startsWith('a'.repeat(128 * 1024))).toBe(true);
    expect(result.stdout).toContain('输出过长已截断');
    expect(result.stdout).toContain('省略中间 128.0KB');
    // 尾部 256KB 完整保留（截断说明附加在其后）
    const tailOnly = result.stdout.slice(128 * 1024, 128 * 1024 + 256 * 1024);
    expect(tailOnly).toBe('b'.repeat(256 * 1024));
    expect(result.exitCode).toBe(0);
  });

  it('达到 4MB 硬上限：onData 返回 false（会话层据此停止续窗口并击杀命令）', async () => {
    const ch = makeChannel();
    const chunk = new Uint8Array(1024 * 1024);
    let accepted = true;
    let acceptedChunks = 0;
    for (let i = 0; i < 6 && accepted; i++) {
      accepted = ch.onExtendedData(chunk);
      if (accepted) acceptedChunks++;
    }
    expect(accepted).toBe(false);
    // 4MB 上限内恰好接受 4 块 1MB
    expect(acceptedChunks).toBe(4);

    ch.onExitStatus(1);
    ch.onClose();
    const result = await ch.getClosedPromise();
    expect(result.stdout).toContain('安全上限');
    expect(result.stdout).toContain('通道已强制关闭');
    expect(result.exitCode).toBe(1);
    // 内存占用受控：即使收到 4MB，解码保留的仅有头尾约 384KB
    expect(result.stdout.length).toBeLessThan(1024 * 1024);
  });

  it('UTF-8 多字节字符跨头/尾边界截断时不会产生乱码（流式解码延续）', async () => {
    const ch = makeChannel();
    // 头部差 1 字节满 128KB，随后「日」字的 3 字节跨越头尾边界
    const headChunk = encoder.encode('a'.repeat(128 * 1024 - 1));
    expect(ch.onData(headChunk)).toBe(true);
    const crossChunk = encoder.encode('日'.repeat(512));
    for (let i = 0; i < crossChunk.length; i++) {
      expect(ch.onData(crossChunk.subarray(i, i + 1))).toBe(true);
    }
    ch.onClose();

    const result = await ch.getClosedPromise();
    expect(result.stdout.startsWith('a'.repeat(128 * 1024 - 1))).toBe(true);
    // 边界处应当完整解码出「日」而不是替换字符：
    // 头部 128KB 的最后 1 字节只装得下该字的首字节，剩余两字节在尾部完成。
    expect(result.stdout.slice(128 * 1024 - 1)).toBe('日'.repeat(512));
    expect(result.stdout).not.toContain('\uFFFD');
  });

  it('MAX_EXEC_CAPTURE_BYTES 导出值与实现一致（会话层依据该常量判定）', () => {
    expect(MAX_EXEC_CAPTURE_BYTES).toBe(4 * 1024 * 1024);
  });
});