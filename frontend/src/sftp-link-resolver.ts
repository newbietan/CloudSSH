export interface SFTPLinkTarget {
  type: 'dir' | 'file';
  size: number;
}

export const SFTP_LINK_STAT_TIMEOUT_MS = 15_000;

type LinkResolveError = 'failed' | 'timeout';

interface PendingLinkStat {
  requestId: string;
  path: string;
  resolve: (target: SFTPLinkTarget | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One on-demand, ID/path-bound STAT; never consumes the editor's untagged STAT replies. */
export class SFTPLinkResolver {
  private pending: PendingLinkStat | null = null;

  constructor(
    private readonly sendJSON: (message: Record<string, unknown>) => void,
    private readonly onError: (reason: LinkResolveError) => void
  ) {}

  resolve(path: string): Promise<SFTPLinkTarget | null> {
    this.cancel();
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => this.finish(null, 'timeout'), SFTP_LINK_STAT_TIMEOUT_MS);
      this.pending = { requestId, path, resolve, timer };
      try {
        this.sendJSON({ type: 'sftp_stat', path, requestId });
      } catch {
        this.finish(null, 'failed');
      }
    });
  }

  handleMessage(message: Record<string, unknown>): boolean {
    const isResult = message.type === 'sftp_stat_result';
    const isError = message.type === 'sftp_error' && message.operation === 'stat';
    if ((!isResult && !isError) || typeof message.requestId !== 'string') return false;

    // Swallow stale tagged replies too, so they cannot resolve an editor save's STAT.
    const pending = this.pending;
    if (!pending || message.requestId !== pending.requestId) return true;
    if (isError) {
      this.finish(null, 'failed');
      return true;
    }
    if (message.path !== pending.path) return true;

    const attrs = message.attrs as Record<string, unknown> | undefined;
    if (
      !attrs ||
      (attrs.type !== 'dir' && attrs.type !== 'file') ||
      typeof attrs.size !== 'number' ||
      !Number.isFinite(attrs.size) ||
      attrs.size < 0
    ) {
      this.finish(null, 'failed');
    } else {
      this.finish({ type: attrs.type, size: attrs.size });
    }
    return true;
  }

  cancel(): void {
    this.finish(null);
  }

  private finish(target: SFTPLinkTarget | null, error?: LinkResolveError): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(target);
    if (error) this.onError(error);
  }
}
