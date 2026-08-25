/**
 * A minimal Socket-compatible byte stream backed by one SSH direct-tcpip
 * channel. It deliberately exposes only the surface SSHSession needs.
 */
export class DirectTcpipStream {
  readonly opened: Promise<void> = Promise.resolve();
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private pendingReads: Uint8Array[] = [];
  private readClosed = false;
  private closed = false;

  constructor(
    private readonly writeChannelData: (data: Uint8Array) => Promise<void>,
    private readonly closeChannel: () => Promise<void>,
    private readonly onRead: (bytes: number) => void
  ) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        this.flushReadable();
      },
      pull: () => this.flushReadable(),
      cancel: () => this.close(),
    });
    this.writable = new WritableStream<Uint8Array>({
      write: async (data) => {
        if (this.closed) throw new Error('direct-tcpip channel is closed');
        await this.writeChannelData(data);
      },
      close: () => this.close(),
      abort: () => this.close(),
    });
  }

  push(data: Uint8Array): void {
    if (this.closed || this.readClosed || data.length === 0) return;
    // Copy because the packet parser may reuse/subarray its source buffer.
    this.pendingReads.push(data.slice());
    this.flushReadable();
  }

  private flushReadable(): void {
    if (this.closed || this.readClosed || !this.controller) return;
    while (this.pendingReads.length > 0 && (this.controller.desiredSize ?? 0) > 0) {
      const data = this.pendingReads.shift()!;
      this.controller.enqueue(data);
      // Replenish the SSH receive window only as the nested consumer pulls.
      this.onRead(data.length);
    }
  }

  remoteClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingReads = [];
    if (error) this.controller?.error(error);
    else this.controller?.close();
    this.controller = null;
  }

  remoteEof(): void {
    if (this.closed || this.readClosed) return;
    this.readClosed = true;
    this.pendingReads = [];
    this.controller?.close();
    this.controller = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingReads = [];
    try {
      this.controller?.close();
    } catch {
      /* 流可能已终断，关闭重复调用可忽略 */
    }
    this.controller = null;
    void this.closeChannel().catch(() => {});
  }
}
