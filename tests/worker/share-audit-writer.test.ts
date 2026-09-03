import { describe, expect, it, vi } from 'vitest';
import {
  SHARE_AUDIT_FLUSH_CHARS,
  ShareAuditWriter,
} from '../../src/worker/share-audit-writer';

describe('ShareAuditWriter 分享会话审计器', () => {
  it('非分享会话时不执行任何审计写入', async () => {
    const fetchFn = vi.fn();
    const env: any = {
      SSH_SHARE: {
        idFromName: vi.fn(),
        get: vi.fn(() => ({ fetch: fetchFn })),
      },
    };
    const writer = new ShareAuditWriter({ env, sessionPolicy: undefined });
    writer.start();

    const ok = await writer.writeAudit('test.event', { foo: 'bar' });
    expect(ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();

    writer.recordTerminalOutput(new TextEncoder().encode('some output'));
    await writer.flushTerminalOutput();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('分享会话时正常向 SSH_SHARE 投递审计事件', async () => {
    const fetchFn = vi.fn(async (_req: Request) => ({ ok: true } as any));
    const env: any = {
      SSH_SHARE: {
        idFromName: vi.fn(() => 'share-id'),
        get: vi.fn(() => ({ fetch: fetchFn })),
      },
    };
    const policy: any = {
      source: 'share',
      shareRef: 'token-ref-123',
    };
    const writer = new ShareAuditWriter({ env, sessionPolicy: policy });
    writer.start();

    const ok = await writer.writeAudit('session.started', { audited: true });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const callArg = (fetchFn.mock.calls as any)[0][0] as Request;
    expect(callArg.url).toBe('http://internal/internal/audit/event');
  });

  it('达到缓冲容量上限时自动分块截断并触发刷新', async () => {
    const postedEvents: any[] = [];
    const fetchFn = vi.fn(async (req: Request) => {
      postedEvents.push(await req.json());
      return { ok: true } as any;
    });
    const env: any = {
      SSH_SHARE: {
        idFromName: vi.fn(() => 'share-id'),
        get: vi.fn(() => ({ fetch: fetchFn })),
      },
    };
    const policy: any = {
      source: 'share',
      shareRef: 'token-ref-123',
    };
    const writer = new ShareAuditWriter({ env, sessionPolicy: policy });
    writer.start();

    // 写入超过单次 flush 限制的数据（8KB * 2）
    const largeText = 'A'.repeat(SHARE_AUDIT_FLUSH_CHARS * 2);
    writer.recordTerminalOutput(new TextEncoder().encode(largeText));
    await writer.flushTerminalOutput();

    expect(postedEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of postedEvents) {
      expect(event.eventType).toBe('terminal.output');
      expect(event.details.text.length).toBeLessThanOrEqual(SHARE_AUDIT_FLUSH_CHARS);
    }
  });

  it('审计写入失败时触发致命错误回调', async () => {
    const onFatalFailure = vi.fn();
    const fetchFn = vi.fn(async () => ({ ok: false } as any));
    const env: any = {
      SSH_SHARE: {
        idFromName: vi.fn(() => 'share-id'),
        get: vi.fn(() => ({ fetch: fetchFn })),
      },
    };
    const policy: any = {
      source: 'share',
      shareRef: 'token-ref-123',
    };
    const writer = new ShareAuditWriter({
      env,
      sessionPolicy: policy,
      onFatalAuditFailure: onFatalFailure,
    });
    writer.start();

    writer.recordTerminalOutput(new TextEncoder().encode('critical failure'));
    const ok = await writer.flushTerminalOutput();
    expect(ok).toBe(false);
    expect(onFatalFailure).toHaveBeenCalled();
  });
});
