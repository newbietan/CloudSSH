import { describe, expect, it } from 'vitest';
import { filterSnippets } from '../frontend/src/snippet-manager';
import type { CommandSnippet } from '../frontend/src/snippet-store';

describe('命令片段搜索过滤', () => {
  const mockSnippets: CommandSnippet[] = [
    {
      id: '1',
      name: '查看磁盘空间',
      command: 'df -h',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: '2',
      name: 'Docker 容器状态',
      command: 'docker ps -a',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: '3',
      name: '重启 Nginx',
      command: 'systemctl restart nginx',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: '4',
      name: 'Nginx 错误日志',
      command: 'tail -f /var/log/nginx/error.log',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ];

  it('空关键词返回全部片段', () => {
    expect(filterSnippets(mockSnippets, '')).toEqual(mockSnippets);
    expect(filterSnippets(mockSnippets, '   ')).toEqual(mockSnippets);
  });

  it('按片段名称过滤（忽略大小写）', () => {
    const results = filterSnippets(mockSnippets, 'nginx');
    expect(results).toHaveLength(2);
    expect(results.map((s) => s.id)).toEqual(['3', '4']);
  });

  it('按命令内容过滤（忽略大小写）', () => {
    const results = filterSnippets(mockSnippets, 'docker ps');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Docker 容器状态');
  });

  it('按命令中的路径或选项过滤', () => {
    const results = filterSnippets(mockSnippets, 'df -h');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('无匹配项时返回空数组', () => {
    const results = filterSnippets(mockSnippets, 'kubernetes');
    expect(results).toHaveLength(0);
  });
});
