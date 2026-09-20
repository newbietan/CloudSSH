/**
 * A minimal Socket-compatible duplex byte stream backed by an outbound
 * Cloudflare Tunnel WebSocket connection.
 * Wraps WebSocket binary frames into WHATWG ReadableStream and WritableStream.
 */
export class TunnelWebSocketStream {
  readonly opened: Promise<void> = Promise.resolve();
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private isClosed = false;

  constructor(private readonly ws: WebSocket) {
    // Ensure binary frames arrive as ArrayBuffer
    this.ws.binaryType = 'arraybuffer';

    const onMessage = (event: MessageEvent) => {
      if (this.isClosed || !this.controller) return;
      try {
        let chunk: Uint8Array;
        if (event.data instanceof ArrayBuffer) {
          chunk = new Uint8Array(event.data);
        } else if (ArrayBuffer.isView(event.data)) {
          chunk = new Uint8Array(
            event.data.buffer,
            event.data.byteOffset,
            event.data.byteLength
          );
        } else if (typeof event.data === 'string') {
          chunk = new TextEncoder().encode(event.data);
        } else {
          return;
        }
        if (chunk.length > 0) {
          this.controller.enqueue(chunk);
        }
      } catch {
        /* ignore if controller is closed */
      }
    };

    const onClose = () => {
      this.closeStream();
    };

    const onError = () => {
      this.closeStream(new Error('Tunnel WebSocket connection error'));
    };

    this.ws.addEventListener('message', onMessage);
    this.ws.addEventListener('close', onClose);
    this.ws.addEventListener('error', onError);

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.close();
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: (data) => {
        if (this.isClosed) {
          throw new Error('Tunnel WebSocket is closed');
        }
        try {
          this.ws.send(data);
        } catch (err) {
          this.closeStream(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      },
      close: () => {
        this.close();
      },
      abort: (reason) => {
        this.closeStream(reason instanceof Error ? reason : new Error(String(reason)));
      },
    });
  }

  private closeStream(error?: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      if (error) {
        this.controller?.error(error);
      } else {
        this.controller?.close();
      }
    } catch {
      /* ignore */
    }
    this.controller = null;
    try {
      this.ws.close(1000, 'Stream closed');
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.closeStream();
  }
}
