// Agent exec channel — manages SSH exec channel lifecycle for command execution

import { SSHChannel } from '../../ssh/channel';
import type { ExecResult } from './types';

export class AgentExecChannel {
  private channelID: number;
  private channel: SSHChannel;
  private stdout: Uint8Array[] = [];
  private stderr: Uint8Array[] = [];
  private exitCode: number = -1;
  private closed: boolean = false;
  private closedResolve!: (result: ExecResult) => void;
  private closedPromise: Promise<ExecResult>;

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

  onData(data: Uint8Array): void {
    this.stdout.push(new Uint8Array(data));
  }

  onExtendedData(data: Uint8Array): void {
    this.stderr.push(new Uint8Array(data));
  }

  onExitStatus(exitCode: number): void {
    this.exitCode = exitCode;
  }

  onClose(): void {
    if (!this.closed) {
      this.closed = true;
      const decoder = new TextDecoder();
      this.closedResolve({
        stdout: decoder.decode(this.concat(this.stdout)),
        stderr: decoder.decode(this.concat(this.stderr)),
        exitCode: this.exitCode,
      });
    }
  }

  onEof(): void {
    // EOF received but channel not closed yet — wait for close
  }

  onChannelOpenFailure(reasonCode: number, description: string): void {
    if (!this.closed) {
      this.closed = true;
      this.closedResolve({
        stdout: '',
        stderr: `Channel open failed (reason=${reasonCode}): ${description}`,
        exitCode: -1,
      });
    }
  }

  private concat(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
