import { describe, expect, it } from 'vitest';
import {
  extractDistillationJson,
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
    const fortyDaysAgo = new Date('2026-02-18T10:00:00').getTime();

    expect(formatTimestampWithRelative(today, base, 'zh-CN')).toContain('今天');
    expect(formatTimestampWithRelative(yesterday, base, 'zh-CN')).toContain('昨天');
    expect(formatTimestampWithRelative(twoDaysAgo, base, 'zh-CN')).toContain('前天');
    // >30 天前直接格式化日期时间，不带冗余的重复括号 (2026-02-18)
    const longAgoZh = formatTimestampWithRelative(fortyDaysAgo, base, 'zh-CN');
    expect(longAgoZh).toContain('2026-02-18');
    expect(longAgoZh).not.toContain('(2026-02-18)');

    expect(formatTimestampWithRelative(today, base, 'en-US')).toContain('Today');
    expect(formatTimestampWithRelative(yesterday, base, 'en-US')).toContain('Yesterday');
    expect(formatTimestampWithRelative(twoDaysAgo, base, 'en-US')).toContain('2 days ago');
    const longAgoEn = formatTimestampWithRelative(fortyDaysAgo, base, 'en-US');
    expect(longAgoEn).toContain('2026-02-18');
    expect(longAgoEn).not.toContain('(2026-02-18)');
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
        mode: 'create',
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
        action: 'set',
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
        action: 'set',
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

  it('extracts distillation JSON robustly across formats and thought wrappers', () => {
    // 1. Pure JSON
    const pure = extractDistillationJson('{"workLog": {"title": "T1", "summary": "S1"}}');
    expect(pure).toEqual({ workLog: { title: 'T1', summary: 'S1' } });

    // 2. Markdown codeblock
    const md = extractDistillationJson('```json\n{"workLog": {"title": "T2", "summary": "S2"}}\n```');
    expect(md).toEqual({ workLog: { title: 'T2', summary: 'S2' } });

    // 3. With <think> tag and markdown block
    const withThinkAndMd = extractDistillationJson(
      '<think>用户进行了硬件查看</think>\n```json\n{"workLog": {"title": "T3", "summary": "S3"}}\n```'
    );
    expect(withThinkAndMd).toEqual({ workLog: { title: 'T3', summary: 'S3' } });

    // 4. With <thought> tag and raw JSON without codeblock
    const withThoughtNoBlock = extractDistillationJson(
      '<thought>分析过程如下：完成</thought>\n{"workLog": {"title": "T4", "summary": "S4"}}'
    );
    expect(withThoughtNoBlock).toEqual({ workLog: { title: 'T4', summary: 'S4' } });

    // 5. Natural language wrapper around JSON
    const naturalLang = extractDistillationJson(
      '经过分析，本次任务总结如下：\n{"workLog": {"title": "T5", "summary": "S5"}}\n请查阅。'
    );
    expect(naturalLang).toEqual({ workLog: { title: 'T5', summary: 'S5' } });

    // 6. Invalid or empty content
    expect(extractDistillationJson('')).toBeNull();
    expect(extractDistillationJson('not a json string')).toBeNull();
    expect(extractDistillationJson('<think>only thought</think>')).toBeNull();

    // 7. With draft inside <think> and real final JSON in markdown block outside
    const withDraftInThink = extractDistillationJson(
      '<think>草稿如下：\n```json\n{"workLog": {"title": "Draft", "summary": "Draft summary"}}\n```\n最终结论如下：</think>\n```json\n{"workLog": {"title": "Final", "summary": "Final summary"}}\n```'
    );
    expect(withDraftInThink).toEqual({ workLog: { title: 'Final', summary: 'Final summary' } });
  });

  it('normalizes workLog input supporting create and update_latest modes', () => {
    const createLog = normalizeWorkLogInput({
      mode: 'create',
      title: '新建任务',
      summary: '新建任务摘要',
    });
    expect(createLog).toEqual({
      ok: true,
      value: {
        mode: 'create',
        title: '新建任务',
        summary: '新建任务摘要',
      },
    });

    const updateLog = normalizeWorkLogInput({
      mode: 'update_latest',
      title: '更新任务',
      summary: '更新任务摘要',
    });
    expect(updateLog).toEqual({
      ok: true,
      value: {
        mode: 'update_latest',
        title: '更新任务',
        summary: '更新任务摘要',
      },
    });

    // 缺省 mode 默认降级为 create
    const defaultLog = normalizeWorkLogInput({
      title: '默认任务',
      summary: '默认任务摘要',
    });
    expect(defaultLog).toEqual({
      ok: true,
      value: {
        mode: 'create',
        title: '默认任务',
        summary: '默认任务摘要',
      },
    });
  });

  it('normalizes knowledge input supporting set and delete actions', () => {
    const setAction = normalizeKnowledgeInput({
      action: 'set',
      category: 'config',
      key: 'port',
      value: '8080',
    });
    expect(setAction).toEqual({
      ok: true,
      value: {
        action: 'set',
        category: 'config',
        key: 'port',
        value: '8080',
      },
    });

    const deleteAction = normalizeKnowledgeInput({
      action: 'delete',
      key: 'port',
    });
    expect(deleteAction).toEqual({
      ok: true,
      value: {
        action: 'delete',
        category: 'note',
        key: 'port',
        value: '',
      },
    });
  });

  it('supports truncate option for workLog and knowledge inputs', () => {
    const longTitle = 'T'.repeat(WORK_LOG_TITLE_MAX_LENGTH + 20);
    const longSummary = 'S'.repeat(WORK_LOG_SUMMARY_MAX_LENGTH + 50);

    const truncatedLog = normalizeWorkLogInput(
      { mode: 'create', title: longTitle, summary: longSummary },
      { truncate: true }
    );
    expect(truncatedLog.ok).toBe(true);
    if (truncatedLog.ok) {
      expect([...truncatedLog.value.title].length).toBe(WORK_LOG_TITLE_MAX_LENGTH);
      expect([...truncatedLog.value.summary].length).toBe(WORK_LOG_SUMMARY_MAX_LENGTH);
    }

    const longValue = 'V'.repeat(KNOWLEDGE_VALUE_MAX_LENGTH + 30);
    const truncatedKnowledge = normalizeKnowledgeInput(
      { key: 'App_Port', value: longValue },
      { truncate: true }
    );
    expect(truncatedKnowledge.ok).toBe(true);
    if (truncatedKnowledge.ok) {
      // Key 统一转换为小写下划线
      expect(truncatedKnowledge.value.key).toBe('app_port');
      expect([...truncatedKnowledge.value.value].length).toBe(KNOWLEDGE_VALUE_MAX_LENGTH);
    }
  });

  it('normalizes knowledge keys by lowercasing and replacing whitespace/hyphens with underscores', () => {
    const k1 = normalizeKnowledgeInput({ key: '  Deploy-Token  ', value: 'token123' });
    expect(k1.ok).toBe(true);
    if (k1.ok) expect(k1.value.key).toBe('deploy_token');

    const k2 = normalizeKnowledgeInput({ key: 'API Key V2', value: 'key123' });
    expect(k2.ok).toBe(true);
    if (k2.ok) expect(k2.value.key).toBe('api_key_v2');
  });
});
