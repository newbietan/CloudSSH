import type { Env, SSHSessionPolicy } from '../types';

export const SHARE_AUDIT_FLUSH_CHARS = 8 * 1024;
export const SHARE_AUDIT_FLUSH_MS = 1000;

export interface ShareAuditWriterOptions {
  env?: Env;
  sessionPolicy?: SSHSessionPolicy;
  waitUntil?: (promise: Promise<unknown>) => void;
  onFatalAuditFailure?: (message: string) => void;
}

export class ShareAuditWriter {
  private shareAuditWrite: Promise<boolean> = Promise.resolve(true);
  private shareAuditBuffer = '';
  private shareAuditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly auditTextDecoder = new TextDecoder();
  private started = false;
  private closed = false;
  private isFlushing: Promise<boolean> | null = null;

  constructor(private readonly options: ShareAuditWriterOptions) {}

  start(): void {
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  writeAudit(eventType: string, details: Record<string, unknown>): Promise<boolean> {
    const policy = this.options.sessionPolicy;
    if (policy?.source !== 'share' || !this.options.env?.SSH_SHARE) return Promise.resolve(false);
    const operation = this.shareAuditWrite.then(async () => {
      try {
        const stub = this.options.env!.SSH_SHARE.get(
          this.options.env!.SSH_SHARE.idFromName(policy.shareRef)
        );
        const response = await stub.fetch(
          new Request('http://internal/internal/audit/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventType, occurredAt: Date.now(), details }),
          })
        );
        return response.ok;
      } catch {
        return false;
      }
    });
    this.shareAuditWrite = operation.catch(() => false);
    return operation;
  }

  recordTerminalOutput(data: Uint8Array): void {
    if (
      !this.started ||
      this.options.sessionPolicy?.source !== 'share' ||
      data.length === 0
    ) {
      return;
    }
    this.shareAuditBuffer += this.auditTextDecoder.decode(data, { stream: true });
    if (this.shareAuditBuffer.length >= SHARE_AUDIT_FLUSH_CHARS) {
      this.runBackground(this.flushTerminalOutput());
      return;
    }
    if (!this.shareAuditFlushTimer) {
      this.shareAuditFlushTimer = setTimeout(() => {
        this.shareAuditFlushTimer = null;
        this.runBackground(this.flushTerminalOutput());
      }, SHARE_AUDIT_FLUSH_MS);
    }
  }

  async flushTerminalOutput(): Promise<boolean> {
    if (this.shareAuditFlushTimer) {
      clearTimeout(this.shareAuditFlushTimer);
      this.shareAuditFlushTimer = null;
    }
    if (this.isFlushing) {
      await this.isFlushing;
    }
    if (!this.shareAuditBuffer) {
      return this.shareAuditWrite;
    }
    const flushPromise = (async () => {
      let text = this.shareAuditBuffer;
      this.shareAuditBuffer = '';
      while (text.length > 0) {
        const chunk = text.slice(0, SHARE_AUDIT_FLUSH_CHARS);
        text = text.slice(SHARE_AUDIT_FLUSH_CHARS);
        const recorded = await this.writeAudit('terminal.output', { text: chunk });
        if (!recorded) {
          this.options.onFatalAuditFailure?.(
            '分享会话审计写入失败或已达到容量上限，连接已终止'
          );
          return false;
        }
      }
      return this.shareAuditWrite;
    })();

    this.isFlushing = flushPromise;
    try {
      return await flushPromise;
    } finally {
      if (this.isFlushing === flushPromise) {
        this.isFlushing = null;
      }
    }
  }

  notifySessionClosed(normal: boolean): void {
    const policy = this.options.sessionPolicy;
    if (policy?.source !== 'share' || !this.options.env?.SSH_SHARE || this.closed) return;
    this.closed = true;
    this.runBackground(
      this.flushTerminalOutput().finally(async () => {
        try {
          const stub = this.options.env!.SSH_SHARE.get(
            this.options.env!.SSH_SHARE.idFromName(policy.shareRef)
          );
          await stub.fetch(
            new Request('http://internal/internal/session/closed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ normal }),
            })
          );
        } catch {
          /* 审计关闭通知失败不影响清理流程 */
        }
      })
    );
  }

  private runBackground(promise: Promise<unknown>): void {
    const guarded = promise.catch(() => undefined);
    if (this.options.waitUntil) {
      this.options.waitUntil(guarded);
    }
  }

  dispose(): void {
    if (this.shareAuditFlushTimer) {
      clearTimeout(this.shareAuditFlushTimer);
      this.shareAuditFlushTimer = null;
    }
    this.shareAuditBuffer = '';
  }
}
