import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_DONE_MAX_LENGTH,
  CHECKPOINT_NEXT_MAX_LENGTH,
  CHECKPOINT_TITLE_MAX_LENGTH,
  containsSensitiveData,
  normalizeCheckpointInput,
} from '../src/checkpoint-schema';

describe('checkpoint-schema', () => {
  it('detects sensitive data in inputs', () => {
    expect(containsSensitiveData('api_key', 'normal text')).toBe(true);
    expect(containsSensitiveData('normal_title', 'sk-abcdef1234567890abcdef1234567890')).toBe(true);
    expect(containsSensitiveData('my_password', 'something')).toBe(true);
    expect(containsSensitiveData('title', 'password: my-secret-value')).toBe(true);
    expect(containsSensitiveData('title', '-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(containsSensitiveData('title', 'bearer abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
    expect(containsSensitiveData('clean_title', 'clean done', 'clean next')).toBe(false);
  });

  it('rejects missing or empty title/done/next', () => {
    expect(normalizeCheckpointInput({})).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeCheckpointInput({ title: '   ' })).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeCheckpointInput({ title: 'Test' })).toEqual({ ok: false, error: 'doneRequired' });
    expect(normalizeCheckpointInput({ title: 'Test', done_summary: '   ' })).toEqual({
      ok: false,
      error: 'doneRequired',
    });
    expect(normalizeCheckpointInput({ title: 'Test', done_summary: 'Done' })).toEqual({
      ok: false,
      error: 'nextRequired',
    });
    expect(
      normalizeCheckpointInput({ title: 'Test', done_summary: 'Done', next_step: '   ' })
    ).toEqual({ ok: false, error: 'nextRequired' });
  });

  it('validates lengths', () => {
    const longTitle = 'a'.repeat(CHECKPOINT_TITLE_MAX_LENGTH + 1);
    expect(
      normalizeCheckpointInput({ title: longTitle, done_summary: 'd', next_step: 'n' })
    ).toEqual({ ok: false, error: 'titleTooLong' });

    const longDone = 'a'.repeat(CHECKPOINT_DONE_MAX_LENGTH + 1);
    expect(
      normalizeCheckpointInput({ title: 't', done_summary: longDone, next_step: 'n' })
    ).toEqual({ ok: false, error: 'doneTooLong' });

    const longNext = 'a'.repeat(CHECKPOINT_NEXT_MAX_LENGTH + 1);
    expect(
      normalizeCheckpointInput({ title: 't', done_summary: 'd', next_step: longNext })
    ).toEqual({ ok: false, error: 'nextTooLong' });
  });

  it('rejects sensitive inputs in normalizeCheckpointInput', () => {
    expect(
      normalizeCheckpointInput({
        title: 'Fix nginx',
        done_summary: 'set token: ghp_123456789012345678901234567890',
        next_step: 'reload nginx',
      })
    ).toEqual({ ok: false, error: 'sensitiveDataDetected' });
  });

  it('normalizes valid input with defaults', () => {
    const res = normalizeCheckpointInput({
      title: '  排查 502 错误  ',
      done_summary: '  重启了应用进程  ',
      next_step: '  等待用户验证接口  ',
      status: 'in_progress',
    });
    expect(res).toEqual({
      ok: true,
      value: {
        title: '排查 502 错误',
        status: 'in_progress',
        done_summary: '重启了应用进程',
        next_step: '等待用户验证接口',
      },
    });

    const defaultStatusRes = normalizeCheckpointInput({
      title: '排查 502 错误',
      done_summary: '重启了应用进程',
      next_step: '等待用户验证接口',
      status: 'invalid_status',
    });
    expect(defaultStatusRes).toEqual({
      ok: true,
      value: {
        title: '排查 502 错误',
        status: 'in_progress',
        done_summary: '重启了应用进程',
        next_step: '等待用户验证接口',
      },
    });
  });
});
