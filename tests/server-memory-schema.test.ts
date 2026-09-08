import { describe, expect, it } from 'vitest';
import {
  formatCurrentTimeAnchor,
  formatTimestampWithRelative,
  isSensitiveKeyOrValue,
  KNOWLEDGE_KEY_MAX_LENGTH,
  KNOWLEDGE_VALUE_MAX_LENGTH,
  normalizeKnowledgeInput,
  normalizeWorkLogInput,
  WORK_LOG_SUMMARY_MAX_LENGTH,
  WORK_LOG_TITLE_MAX_LENGTH,
} from '../src/server-memory-schema';

describe('server-memory-schema', () => {
  it('formats current time anchor for prompt', () => {
    // 2026-03-30 14:30:00 (Monday)
    const fixedTime = new Date('2026-03-30T14:30:00Z').getTime();
    const anchorZh = formatCurrentTimeAnchor(fixedTime, 'zh-CN');
    const anchorEn = formatCurrentTimeAnchor(fixedTime, 'en-US');

    expect(anchorZh).toContain('2026-');
    expect(anchorEn).toContain('2026-');
  });

  it('formats timestamp with relative day context', () => {
    const base = new Date('2026-03-30T12:00:00').getTime();
    const today = new Date('2026-03-30T09:15:00').getTime();
    const yesterday = new Date('2026-03-29T16:20:00').getTime();
    const twoDaysAgo = new Date('2026-03-28T10:00:00').getTime();

    expect(formatTimestampWithRelative(today, base, 'zh-CN')).toContain('今天');
    expect(formatTimestampWithRelative(yesterday, base, 'zh-CN')).toContain('昨天');
    expect(formatTimestampWithRelative(twoDaysAgo, base, 'zh-CN')).toContain('前天');

    expect(formatTimestampWithRelative(today, base, 'en-US')).toContain('Today');
    expect(formatTimestampWithRelative(yesterday, base, 'en-US')).toContain('Yesterday');
    expect(formatTimestampWithRelative(twoDaysAgo, base, 'en-US')).toContain('2 days ago');
  });

  it('formats current time anchor and relative timestamps with custom user timezone', () => {
    // 2026-09-08 12:00:00 UTC = 2026-09-08 20:00:00 Asia/Shanghai = 2026-09-08 08:00:00 America/New_York
    const ts = new Date('2026-09-08T12:00:00Z').getTime();

    const anchorShanghai = formatCurrentTimeAnchor(ts, 'zh-CN', 'Asia/Shanghai');
    expect(anchorShanghai).toContain('2026-09-08 20:00:00');
    expect(anchorShanghai).toContain('时区: Asia/Shanghai');

    const anchorNY = formatCurrentTimeAnchor(ts, 'en-US', 'America/New_York');
    expect(anchorNY).toContain('2026-09-08 08:00:00');
    expect(anchorNY).toContain('Timezone: America/New_York');

    const relativeShanghai = formatTimestampWithRelative(ts, ts + 3600_000, 'zh-CN', 'Asia/Shanghai');
    expect(relativeShanghai).toContain('20:00 (今天)');

    const relativeNY = formatTimestampWithRelative(ts, ts + 3600_000, 'en-US', 'America/New_York');
    expect(relativeNY).toContain('08:00 (Today)');
  });

  it('validates work log inputs', () => {
    expect(normalizeWorkLogInput({})).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeWorkLogInput({ title: '  ' })).toEqual({ ok: false, error: 'titleRequired' });
    expect(normalizeWorkLogInput({ title: 'Check hardware' })).toEqual({ ok: false, error: 'summaryRequired' });

    const longTitle = 'a'.repeat(WORK_LOG_TITLE_MAX_LENGTH + 1);
    expect(normalizeWorkLogInput({ title: longTitle, summary: 'done' })).toEqual({
      ok: false,
      error: 'titleTooLong',
    });

    const longSummary = 'b'.repeat(WORK_LOG_SUMMARY_MAX_LENGTH + 1);
    expect(normalizeWorkLogInput({ title: 'title', summary: longSummary })).toEqual({
      ok: false,
      error: 'summaryTooLong',
    });

    const valid = normalizeWorkLogInput({
      title: '  查看服务器硬件信息  ',
      summary: '  CPU 占用正常，内存余量充足  ',
    });
    expect(valid).toEqual({
      ok: true,
      value: {
        title: '查看服务器硬件信息',
        summary: 'CPU 占用正常，内存余量充足',
      },
    });
  });

  it('validates and categorizes knowledge and credential inputs', () => {
    expect(normalizeKnowledgeInput({})).toEqual({ ok: false, error: 'keyRequired' });
    expect(normalizeKnowledgeInput({ key: 'deploy_token' })).toEqual({ ok: false, error: 'valueRequired' });

    const longKey = 'k'.repeat(KNOWLEDGE_KEY_MAX_LENGTH + 1);
    expect(normalizeKnowledgeInput({ key: longKey, value: 'v' })).toEqual({
      ok: false,
      error: 'keyTooLong',
    });

    const longVal = 'v'.repeat(KNOWLEDGE_VALUE_MAX_LENGTH + 1);
    expect(normalizeKnowledgeInput({ key: 'k', value: longVal })).toEqual({
      ok: false,
      error: 'valueTooLong',
    });

    // Auto-infers 'credential' category for keys or tokens
    const cred = normalizeKnowledgeInput({
      key: 'deploy_token',
      value: 'ghp_abcdef1234567890abcdef12345678901234',
    });
    expect(cred).toEqual({
      ok: true,
      value: {
        category: 'credential',
        key: 'deploy_token',
        value: 'ghp_abcdef1234567890abcdef12345678901234',
      },
    });

    // Respects explicit category
    const config = normalizeKnowledgeInput({
      category: 'config',
      key: 'app_port',
      value: '8080',
    });
    expect(config).toEqual({
      ok: true,
      value: {
        category: 'config',
        key: 'app_port',
        value: '8080',
      },
    });
  });

  it('detects sensitive keys or values for UI masking', () => {
    expect(isSensitiveKeyOrValue('db_password', '123456')).toBe(true);
    expect(isSensitiveKeyOrValue('api_key', 'some-key')).toBe(true);
    expect(isSensitiveKeyOrValue('token', 'ghp_12345')).toBe(true);
    expect(isSensitiveKeyOrValue('normal_key', 'normal_val')).toBe(false);
  });
});
