/**
 * 校验 Cloudflare 隧道域名是否为合法的标准主机名/域名格式。
 * 必须包含至少一个点，且不能是 IP 地址或非法字符。
 */
export function isValidTunnelHostname(host: string): boolean {
  if (!host || typeof host !== 'string') return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 253) return false;
  if (/[\s/:\\]/.test(trimmed)) return false;
  if (!trimmed.includes('.')) return false;
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) return false;
  // 排除 IPv4 纯数字 IP
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) return false;

  const labels = trimmed.split('.');
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

// cloudflared 2026.9.3/2026.10.0 TCP-over-WebSocket uses a 16KiB copy buffer.
// Conn.Read copies a whole message into it without retaining an oversized tail.
// Cap the encrypted carrier message, NOT just the SSH channel data payload.
const MAX_TUNNEL_WEBSOCKET_MESSAGE_BYTES = 16 * 1024;

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
  private lastWriteTime = 0;

  private readonly onMessage: (event: MessageEvent) => void;
  private readonly onClose: (event?: any) => void;
  private readonly onError: (event?: any) => void;

  constructor(
    private readonly ws: WebSocket,
    private readonly onDebug?: (msg: string) => void
  ) {
    // Ensure binary frames arrive as ArrayBuffer
    this.ws.binaryType = 'arraybuffer';

    this.onMessage = (event: MessageEvent) => {
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

    this.onClose = (event?: any) => {
      const code = event && typeof event.code === 'number' ? event.code : 1000;
      const reason = event && typeof event.reason === 'string' ? event.reason : '';
      this.onDebug?.(`[TunnelWS] closed: code=${code}, reason=${reason || '(none)'}`);
      this.closeStream();
    };

    this.onError = (event?: any) => {
      const msg = event instanceof Error ? event.message : 'Tunnel WebSocket connection error';
      this.onDebug?.(`[TunnelWS] error: ${msg}`);
      this.closeStream(new Error('Tunnel WebSocket connection error'));
    };

    this.ws.addEventListener('message', this.onMessage);
    this.ws.addEventListener('close', this.onClose);
    this.ws.addEventListener('error', this.onError);

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.close();
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: async (data) => {
        if (this.isClosed) {
          throw new Error('Tunnel WebSocket is closed');
        }
        try {
          // WebSocket message boundaries are independent of SSH packet boundaries.
          // Split AFTER encryption so headers, padding and MAC/tag bytes also fit.
          // The serialized WritableStream preserves every byte's original order.
          for (let offset = 0; offset < data.length; offset += MAX_TUNNEL_WEBSOCKET_MESSAGE_BYTES) {
            const frame = data.subarray(offset, offset + MAX_TUNNEL_WEBSOCKET_MESSAGE_BYTES);
            if (frame.length >= 8192) {
              const elapsed = Date.now() - this.lastWriteTime;
              if (elapsed < 2) {
                await new Promise((resolve) => setTimeout(resolve, 2 - elapsed));
              }
              this.lastWriteTime = Date.now();
            }
            // The connection can close while waiting between carrier messages.
            if (this.isClosed) {
              throw new Error('Tunnel WebSocket is closed');
            }
            this.ws.send(frame);
          }
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
      this.ws.removeEventListener('message', this.onMessage);
      this.ws.removeEventListener('close', this.onClose);
      this.ws.removeEventListener('error', this.onError);
    } catch {
      /* ignore */
    }

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
