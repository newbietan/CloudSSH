// Terminal output buffer for Agent context reading (DO-side)

export class TerminalContext {
  private outputBuffer: string = '';
  private maxBufferSize = 50_000;

  appendOutput(chunk: string): void {
    this.outputBuffer += chunk;
    if (this.outputBuffer.length > this.maxBufferSize) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferSize);
    }
  }

  snapshot(lastLines: number = 200): string {
    const lines = this.outputBuffer.split('\n');
    const start = Math.max(0, lines.length - lastLines);
    return lines.slice(start).join('\n').trimEnd();
  }

  clear(): void {
    this.outputBuffer = '';
  }
}
