import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ALL,
  CATEGORY_UNCATEGORIZED,
  filterSnippets,
} from '../frontend/src/snippet-manager';
import type { CommandSnippet } from '../frontend/src/snippet-store';

describe('命令片段搜索与分类过滤', () => {
  const mockSnippets: CommandSnippet[] = [
    {
      id: '1',
      name: '查看磁盘空间',
      command: 'df -h',
      category: '运维/监控',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: '2',
      name: 'Docker 容器状态',
      command: 'docker ps -a',
      category: 'Docker',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: '3',
      name: '重启 Nginx',
      command: 'systemctl restart nginx',
      category: 'Web服务',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: '4',
      name: 'Nginx 错误日志',
      command: 'tail -f /var/log/nginx/error.log',
      category: '',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  ];

  it('空关键词与全部分类返回全部片段', () => {
    expect(filterSnippets(mockSnippets, '', CATEGORY_ALL)).toEqual(mockSnippets);
    expect(filterSnippets(mockSnippets, '   ', '')).toEqual(mockSnippets);
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

  it('按指定分类过滤', () => {
    const dockerResults = filterSnippets(mockSnippets, '', 'Docker');
    expect(dockerResults).toHaveLength(1);
    expect(dockerResults[0].id).toBe('2');

    const opsResults = filterSnippets(mockSnippets, '', '运维/监控');
    expect(opsResults).toHaveLength(1);
    expect(opsResults[0].id).toBe('1');
  });

  it('按未分类过滤返回 category 为空的片段', () => {
    const results = filterSnippets(mockSnippets, '', CATEGORY_UNCATEGORIZED);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('4');
  });

  it('组合搜索：分类与关键词交集过滤', () => {
    // 搜索 nginx 且分类限定 Web服务 -> 仅返回 id 3
    const results = filterSnippets(mockSnippets, 'nginx', 'Web服务');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('3');

    // 搜索 nginx 但分类限定 Docker -> 无匹配
    const noResults = filterSnippets(mockSnippets, 'nginx', 'Docker');
    expect(noResults).toHaveLength(0);
  });

  it('无匹配项时返回空数组', () => {
    const results = filterSnippets(mockSnippets, 'kubernetes');
    expect(results).toHaveLength(0);
  });
});
