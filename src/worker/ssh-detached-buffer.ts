import { SESSION_RING_BUFFER_MAX_BYTES } from '../types';

export interface DetachedBufferCallbacks {
  recordTerminalOutput?: (data: Uint8Array) => void;
  queueWindowAdjust?: (bytes: number) => void;
  sendDebug?: (message: string) => void;
}

export class DetachedSessionBuffer {
  private detached = false;
  private outputBuffer: Uint8Array[] = [];
  private bufferBytes = 0;
  private unadjustedBytes = 0;

  constructor(private readonly maxBytes: number = SESSION_RING_BUFFER_MAX_BYTES) {}

  isDetached(): boolean {
    return this.detached;
  }

  setDetached(detached: boolean): boolean {
    if (this.detached === detached) return false;
    this.detached = detached;
    return true;
  }

  handleOutput(data: Uint8Array, callbacks?: DetachedBufferCallbacks): void {
    if (this.bufferBytes + data.length <= this.maxBytes) {
      this.outputBuffer.push(data.slice());
      this.bufferBytes += data.length;
      callbacks?.recordTerminalOutput?.(data);
      callbacks?.queueWindowAdjust?.(data.length);
    } else {
      this.unadjustedBytes += data.length;
      callbacks?.sendDebug?.(
        'Detached buffer reached 128KB limit; pausing window adjust for backpressure'
      );
    }
  }

  drainOutput(): Uint8Array[] {
    const chunks = this.outputBuffer;
    this.outputBuffer = [];
    this.bufferBytes = 0;
    return chunks;
  }

  consumeUnadjustedBytes(): number {
    const bytes = this.unadjustedBytes;
    this.unadjustedBytes = 0;
    return bytes;
  }

  clear(): void {
    this.detached = false;
    this.outputBuffer = [];
    this.bufferBytes = 0;
    this.unadjustedBytes = 0;
  }

  get detachedOutputBuffer(): Uint8Array[] {
    return this.outputBuffer;
  }

  setOutputBuffer(buffer: Uint8Array[]): void {
    this.outputBuffer = buffer;
  }

  get detachedBufferBytes(): number {
    return this.bufferBytes;
  }

  setDetachedBufferBytes(bytes: number): void {
    this.bufferBytes = bytes;
  }

  get unadjustedDetachedBytes(): number {
    return this.unadjustedBytes;
  }

  setUnadjustedDetachedBytes(bytes: number): void {
    this.unadjustedBytes = bytes;
  }
}
