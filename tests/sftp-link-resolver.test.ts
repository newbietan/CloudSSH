import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SFTPLinkResolver,
  SFTP_LINK_STAT_TIMEOUT_MS,
} from '../frontend/src/sftp-link-resolver';

function setup() {
  const sendJSON = vi.fn();
  const onError = vi.fn();
  const resolver = new SFTPLinkResolver(sendJSON, onError);
  const reply = (attrs: Record<string, unknown> = { type: 'dir', size: 4096 }) => ({
    ...sendJSON.mock.calls[sendJSON.mock.calls.length - 1][0],
    type: 'sftp_stat_result',
    attrs,
  });
  return { resolver, sendJSON, onError, reply };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('on-demand SFTP symlink target resolution', () => {
  it.each(['dir', 'file'] as const)('resolves %s targets using the link path', async (type) => {
    const { resolver, sendJSON, onError, reply } = setup();
    expect(sendJSON).not.toHaveBeenCalled();
    const pending = resolver.resolve('/home/to_dir');
    expect(sendJSON).toHaveBeenCalledExactlyOnceWith({
      type: 'sftp_stat', path: '/home/to_dir', requestId: expect.any(String),
    });
    expect(resolver.handleMessage(reply({ type, size: 4096 }))).toBe(true);
    await expect(pending).resolves.toEqual({ type, size: 4096 });
    expect(onError).not.toHaveBeenCalled();
  });

  it('requires both the current ID and path and leaves editor STAT replies alone', async () => {
    const { resolver, reply } = setup();
    const pending = resolver.resolve('/root/to_dir');
    expect(resolver.handleMessage({ type: 'sftp_stat_result', attrs: {} })).toBe(false);
    expect(resolver.handleMessage({ type: 'sftp_error', operation: 'stat' })).toBe(false);
    expect(resolver.handleMessage({ ...reply(), requestId: 'old' })).toBe(true);
    expect(resolver.handleMessage({ ...reply(), path: '/wrong' })).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    resolver.handleMessage(reply());
    await expect(pending).resolves.toMatchObject({ type: 'dir' });
  });

  it('supersedes one pending open and ignores its late success and failure', async () => {
    const { resolver, onError, reply } = setup();
    const old = resolver.resolve('/old');
    const oldReply = reply();
    const current = resolver.resolve('/new');
    await expect(old).resolves.toBeNull();
    resolver.handleMessage(oldReply);
    resolver.handleMessage({ ...oldReply, type: 'sftp_error', operation: 'stat' });
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    resolver.handleMessage(reply({ type: 'file', size: 20 }));
    await expect(current).resolves.toEqual({ type: 'file', size: 20 });
  });

  it('cancels silently on navigation/close and consumes late tagged replies', async () => {
    const { resolver, onError, reply } = setup();
    const pending = resolver.resolve('/home/link');
    const late = reply();
    resolver.cancel();
    resolver.cancel();
    await expect(pending).resolves.toBeNull();
    expect(resolver.handleMessage(late)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports target lookup failures without opening anything', async () => {
    const { resolver, onError, reply } = setup();
    const pending = resolver.resolve('/home/broken');
    resolver.handleMessage({ ...reply(), type: 'sftp_error', operation: 'stat' });
    await expect(pending).resolves.toBeNull();
    expect(onError).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('times out once and ignores a late reply', async () => {
    const { resolver, onError, reply } = setup();
    const pending = resolver.resolve('/slow');
    const late = reply();
    await vi.advanceTimersByTimeAsync(SFTP_LINK_STAT_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(onError).toHaveBeenCalledExactlyOnceWith('timeout');
    resolver.handleMessage(late);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'link', size: 1 },
    { type: 'dir', size: -1 },
    { type: 'file', size: Number.NaN },
    { type: 'file', size: '20' },
    {},
  ])('fails closed for invalid target attributes: %j', async (attrs) => {
    const { resolver, onError, reply } = setup();
    const pending = resolver.resolve('/invalid');
    resolver.handleMessage(reply(attrs));
    await expect(pending).resolves.toBeNull();
    expect(onError).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('releases the timer if sending fails', async () => {
    const onError = vi.fn();
    const resolver = new SFTPLinkResolver(() => {
      throw new Error('closed');
    }, onError);
    await expect(resolver.resolve('/link')).resolves.toBeNull();
    expect(onError).toHaveBeenCalledExactlyOnceWith('failed');
  });
});
