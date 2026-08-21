// Agent exec channel — manages SSH exec channel lifecycle for command execution

import type { SSHChannel } from '../../ssh/channel';
import type { ExecResult } from './types';

/**
 * 输出捕获硬上限：防止 docker logs 等大输出命令把 DO isolate 内存打爆（OOM）。
 * 达到上限后不再续 SSH window（服务器自然停止推送），并且由会话层关闭通道，
 * sshd 会随之终止远端命令。
 */
export const MAX_EXEC_CAPTURE_BYTES = 4 * 1024 * 1024;

// 捕获内容采用「头部 + 滚动尾部」的环形保留策略：丢弃中段、保留头尾，
// 与 head/tail 日志工具、CI 日志平台的截断语义一致。
const KEEP_HEAD_BYTES = 128 * 1024;
const KEEP_TAIL_BYTES = 256 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** stdout 与 stderr 共享的累计计数（硬上限按合并总量计算）。 */
interface CaptureBudget {
  captured: number;
  limitExceeded: boolean;
}

/**
 * 单条输出流的有界捕获：直接持有 subarray 视图（零拷贝），
 * 头部留满后转入滚动尾部，丢弃的中间部分计入 discarded。
 */
class BoundedStreamCapture {
  private headChunks: Uint8Array[] = [];
  private headBytes = 0;
  private headClosed = false;
  private tailChunks: Uint8Array[] = [];
  private tailBytes = 0;
  discarded = 0;

  constructor(private readonly budget: CaptureBudget) {}

  /** 追加一块数据。返回 false 表示达到硬上限，调用方必须停止续 window。 */
  append(chunk: Uint8Array): boolean {
    if (this.budget.limitExceeded || chunk.length === 0) {
      return !this.budget.limitExceeded || chunk.length === 0;
    }

    this.budget.captured += chunk.length;
    if (this.budget.captured > MAX_EXEC_CAPTURE_BYTES) {
      this.budget.captured -= chunk.length;
      this.budget.limitExceeded = true;
      return false;
    }

    let rest = chunk;
    if (!this.headClosed) {
      const headRoom = KEEP_HEAD_BYTES - this.headBytes;
      if (rest.length <= headRoom) {
        this.headChunks.push(rest);
        this.headBytes += rest.length;
        return true;
      }
      if (headRoom > 0) {
        this.headChunks.push(rest.subarray(0, headRoom));
        this.headBytes += headRoom;
      }
      this.headClosed = true;
      rest = rest.subarray(Math.min(rest.length, headRoom));
    }

    this.appendToTail(rest);
    return true;
  }

  private appendToTail(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.tailChunks.push(chunk);
    this.tailBytes += chunk.length;

    // 滚动：丢弃最旧块，直至落在 KEEP_TAIL_BYTES 之内。
    // 仅剩一块时保留它，交给下方的大块切割处理。
    while (this.tailBytes > KEEP_TAIL_BYTES && this.tailChunks.length > 1) {
      const oldest = this.tailChunks.shift()!;
      this.tailBytes -= oldest.length;
      this.discarded += oldest.length;
    }

    // 单个块超过尾部预算（异常情况）：只保留其末尾。
    if (this.tailBytes > KEEP_TAIL_BYTES) {
      const first = this.tailChunks[0];
      const overflow = this.tailBytes - KEEP_TAIL_BYTES;
      this.tailChunks[0] = first.subarray(overflow);
      this.tailBytes -= overflow;
      this.discarded += overflow;
    }
  }

  /** 把所有保留块按流式状态解码（正确处理跨块拆分的多字节 UTF-8）。 */
  decode(): string {
    const decoder = new TextDecoder();
    let out = '';
    for (const chunk of this.headChunks) {
      out += decoder.decode(chunk, { stream: true });
    }
    for (const chunk of this.tailChunks) {
      out += decoder.decode(chunk, { stream: true });
    }
    out += decoder.decode();
    return out;
  }
}

export class AgentExecChannel {
  private channelID: number;
  private channel: SSHChannel;
  private exitCode: number = -1;
  private closed: boolean = false;
  private closedResolve!: (result: ExecResult) => void;
  private closedPromise: Promise<ExecResult>;
  private openConfirmed: boolean = false;
  private openFailed: boolean = false;

  private readonly budget: CaptureBudget = { captured: 0, limitExceeded: false };
  private readonly stdoutCapture = new BoundedStreamCapture(this.budget);
  private readonly stderrCapture = new BoundedStreamCapture(this.budget);

  constructor(channelID: number, channel: SSHChannel) {
    this.channelID = channelID;
    this.channel = channel;
    this.closedPromise = new Promise<ExecResult>((resolve) => {
      this.closedResolve = resolve;
    });
  }

  getChannelID(): number {
    return this.channelID;
  }

  getChannel(): SSHChannel {
    return this.channel;
  }

  getClosedPromise(): Promise<ExecResult> {
    return this.closedPromise;
  }

  isOpenConfirmed(): boolean {
    return this.openConfirmed;
  }

  isOpenFailed(): boolean {
    return this.openFailed;
  }

  /** 返回 false 表示已超过捕获硬上限，调用方必须停止续 window 并关闭通道。 */
  onData(data: Uint8Array): boolean {
    return this.stdoutCapture.append(data);
  }

  /** 返回 false 表示已超过捕获硬上限，调用方必须停止续 window 并关闭通道。 */
  onExtendedData(data: Uint8Array): boolean {
    return this.stderrCapture.append(data);
  }

  onExitStatus(exitCode: number): void {
    this.exitCode = exitCode;
  }

  onOpenConfirmation(): void {
    this.openConfirmed = true;
  }

  onChannelOpenFailure(reasonCode: number, description: string): void {
    if (!this.closed) {
      this.openFailed = true;
      this.closed = true;
      this.closedResolve({
        stdout: '',
        stderr: `Channel open failed (reason=${reasonCode}): ${description}`,
        exitCode: -1,
      });
    }
  }

  onClose(): void {
    if (!this.closed) {
      this.closed = true;
      const notes: string[] = [];
      if (this.budget.limitExceeded) {
        notes.push(
          `[输出超过 ${formatBytes(MAX_EXEC_CAPTURE_BYTES)} 安全上限，通道已强制关闭，远端命令已被终止]`
        );
      } else {
        const streams: Array<[string, BoundedStreamCapture]> = [
          ['stdout', this.stdoutCapture],
          ['stderr', this.stderrCapture],
        ];
        for (const [name, capture] of streams) {
          if (capture.discarded > 0) {
            notes.push(
              `[${name} 输出过长已截断：省略中间 ${formatBytes(capture.discarded)}，仅保留前 ${formatBytes(
                KEEP_HEAD_BYTES
              )} 与后 ${formatBytes(KEEP_TAIL_BYTES)}]`
            );
          }
        }
      }

      const stdout = this.stdoutCapture.decode();
      const stderr = this.stderrCapture.decode();
      this.closedResolve({
        stdout: notes.length > 0 ? `${stdout}\n${notes.join('\n')}\n` : stdout,
        stderr,
        exitCode: this.exitCode,
      });
    }
  }

  onEof(): void {
    // EOF received but channel not closed yet — wait for close
  }
}
