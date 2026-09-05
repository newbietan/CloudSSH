import { describe, expect, it } from 'vitest';
import {
  normalizeSnippetInput,
  SNIPPET_CATEGORY_MAX_LENGTH,
  SNIPPET_COMMAND_MAX_LENGTH,
  SNIPPET_MAX_COUNT,
  SNIPPET_NAME_MAX_LENGTH,
} from '../src/snippet-schema';

describe('snippet-schema 校验', () => {
  it('常量符合产品约定', () => {
    expect(SNIPPET_MAX_COUNT).toBe(100);
    expect(SNIPPET_NAME_MAX_LENGTH).toBe(50);
    expect(SNIPPET_CATEGORY_MAX_LENGTH).toBe(30);
    expect(SNIPPET_COMMAND_MAX_LENGTH).toBe(2000);
  });

  it('通过合法输入并去除首尾空白', () => {
    expect(normalizeSnippetInput('  查看磁盘  ', '  df -h  ')).toEqual({
      ok: true,
      value: { name: '查看磁盘', command: 'df -h', category: '' },
    });
    expect(normalizeSnippetInput('  查看磁盘  ', '  df -h  ', '  运维/系统  ')).toEqual({
      ok: true,
      value: { name: '查看磁盘', command: 'df -h', category: '运维/系统' },
    });
  });

  it('名称与命令均不能为空', () => {
    expect(normalizeSnippetInput('', 'df -h')).toEqual({ ok: false, error: 'nameRequired' });
    expect(normalizeSnippetInput('  ', 'df -h')).toEqual({ ok: false, error: 'nameRequired' });
    expect(normalizeSnippetInput('ok', '')).toEqual({ ok: false, error: 'commandRequired' });
    expect(normalizeSnippetInput('ok', '  ')).toEqual({ ok: false, error: 'commandRequired' });
  });

  it('非字符串类型按缺失处理', () => {
    expect(normalizeSnippetInput(null as unknown as string, 'df -h')).toEqual({
      ok: false,
      error: 'nameRequired',
    });
    expect(normalizeSnippetInput('ok', null as unknown as string)).toEqual({
      ok: false,
      error: 'commandRequired',
    });
  });

  it('名称与命令超长被拒绝', () => {
    expect(normalizeSnippetInput('a'.repeat(51), 'df -h')).toEqual({
      ok: false,
      error: 'nameTooLong',
    });
    expect(normalizeSnippetInput('ok', 'a'.repeat(2001))).toEqual({
      ok: false,
      error: 'commandTooLong',
    });
  });

  it('分类超长被拒绝', () => {
    expect(normalizeSnippetInput('ok', 'df -h', 'a'.repeat(31))).toEqual({
      ok: false,
      error: 'categoryTooLong',
    });
    expect(normalizeSnippetInput('ok', 'df -h', 123 as unknown as string)).toEqual({
      ok: false,
      error: 'categoryTooLong',
    });
  });

  it('按 Unicode 码点计数而非字节长度', () => {
    expect(normalizeSnippetInput('😀'.repeat(50), 'echo hi', '🚀'.repeat(30))).toEqual({
      ok: true,
      value: { name: '😀'.repeat(50), command: 'echo hi', category: '🚀'.repeat(30) },
    });
    expect(normalizeSnippetInput('😀'.repeat(51), 'echo hi')).toEqual({
      ok: false,
      error: 'nameTooLong',
    });
    expect(normalizeSnippetInput('ok', 'echo hi', '🚀'.repeat(31))).toEqual({
      ok: false,
      error: 'categoryTooLong',
    });
  });
});
