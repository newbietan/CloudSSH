import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatSize,
  formatTimestamp,
  getFileIcon,
  parsePathBreadcrumbs,
  sortSFTPEntries,
  type SFTPSortOptions,
  type SortableEntry,
} from '../frontend/src/sftp-helpers';

describe('SFTP 路径面包屑解析 (parsePathBreadcrumbs)', () => {
  it('根目录解析为一个根节点', () => {
    expect(parsePathBreadcrumbs('/')).toEqual([{ name: '/', path: '/' }]);
  });

  it('单层目录解析', () => {
    expect(parsePathBreadcrumbs('/etc')).toEqual([
      { name: '/', path: '/' },
      { name: 'etc', path: '/etc' },
    ]);
  });

  it('深层目录逐级解析完整路径', () => {
    expect(parsePathBreadcrumbs('/var/log/nginx')).toEqual([
      { name: '/', path: '/' },
      { name: 'var', path: '/var' },
      { name: 'log', path: '/var/log' },
      { name: 'nginx', path: '/var/log/nginx' },
    ]);
  });

  it('处理缺少前导斜杠或带尾随斜杠的路径', () => {
    expect(parsePathBreadcrumbs('home/ubuntu/')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'ubuntu', path: '/home/ubuntu' },
    ]);
  });
});

describe('SFTP 文件条目排序 (sortSFTPEntries)', () => {
  const sampleEntries: SortableEntry[] = [
    { name: 'zebra.txt', isDir: false, size: 500, modifiedTime: 1000 },
    { name: 'alpha.txt', isDir: false, size: 1500, modifiedTime: 3000 },
    { name: 'beta.txt', isDir: false, size: 200, modifiedTime: 2000 },
    { name: 'docs', isDir: true, size: 0, modifiedTime: 4000 },
    { name: 'bin', isDir: true, size: 0, modifiedTime: 500 },
  ];

  it('始终将目录排在文件前面，同类型按名称升序', () => {
    const sort: SFTPSortOptions = { field: 'name', direction: 'asc' };
    const sorted = sortSFTPEntries(sampleEntries, sort);
    expect(sorted.map((e) => e.name)).toEqual([
      'bin',
      'docs',
      'alpha.txt',
      'beta.txt',
      'zebra.txt',
    ]);
  });

  it('按名称降序排列（目录依然在文件前）', () => {
    const sort: SFTPSortOptions = { field: 'name', direction: 'desc' };
    const sorted = sortSFTPEntries(sampleEntries, sort);
    expect(sorted.map((e) => e.name)).toEqual([
      'docs',
      'bin',
      'zebra.txt',
      'beta.txt',
      'alpha.txt',
    ]);
  });

  it('按文件大小升序排列', () => {
    const sort: SFTPSortOptions = { field: 'size', direction: 'asc' };
    const sorted = sortSFTPEntries(sampleEntries, sort);
    // 目录 size=0 且在最前，文件按 200 -> 500 -> 1500
    expect(sorted.map((e) => e.name)).toEqual([
      'bin',
      'docs',
      'beta.txt',
      'zebra.txt',
      'alpha.txt',
    ]);
  });

  it('按文件大小降序排列', () => {
    const sort: SFTPSortOptions = { field: 'size', direction: 'desc' };
    const sorted = sortSFTPEntries(sampleEntries, sort);
    // 目录依然置顶，文件从大到小 1500 -> 500 -> 200
    expect(sorted.map((e) => e.name)).toEqual([
      'bin',
      'docs',
      'alpha.txt',
      'zebra.txt',
      'beta.txt',
    ]);
  });

  it('按修改时间降序排列（新修改的排在最前）', () => {
    const sort: SFTPSortOptions = { field: 'mtime', direction: 'desc' };
    const sorted = sortSFTPEntries(sampleEntries, sort);
    // 目录：docs (4000) > bin (500)
    // 文件：alpha (3000) > beta (2000) > zebra (1000)
    expect(sorted.map((e) => e.name)).toEqual([
      'docs',
      'bin',
      'alpha.txt',
      'beta.txt',
      'zebra.txt',
    ]);
  });

  it('按修改时间升序排列（旧文件排在最前）', () => {
    const sort: SFTPSortOptions = { field: 'mtime', direction: 'asc' };
    const sorted = sortSFTPEntries(sampleEntries, sort);
    // 目录：bin (500) < docs (4000)
    // 文件：zebra (1000) < beta (2000) < alpha (3000)
    expect(sorted.map((e) => e.name)).toEqual([
      'bin',
      'docs',
      'zebra.txt',
      'beta.txt',
      'alpha.txt',
    ]);
  });

  describe('SFTP 格式化与辅助工具 (sftp-helpers)', () => {
    it('formatSize 格式化不同字节大小', () => {
      expect(formatSize(500)).toBe('500 B');
      expect(formatSize(2048)).toBe('2.0 KB');
      expect(formatSize(10 * 1024 * 1024)).toBe('10.0 MB');
      expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
    });

    it('formatTimestamp 格式化时间戳', () => {
      expect(formatTimestamp(0)).toBe('');
      const recent = Math.floor(Date.now() / 1000) - 3600; // 1小时前
      expect(formatTimestamp(recent)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('getFileIcon 映射扩展名到图标', () => {
      expect(getFileIcon('app.ts')).toBe('javascript');
      expect(getFileIcon('index.py')).toBe('code');
      expect(getFileIcon('run.sh')).toBe('terminal');
      expect(getFileIcon('image.png')).toBe('image');
      expect(getFileIcon('archive.tar.gz')).toBe('folder_zip');
      expect(getFileIcon('unknown_file')).toBe('draft');
    });

    it('escapeHtml 转义特殊危险字符', () => {
      expect(escapeHtml('<script>alert("xss")&</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&amp;&lt;/script&gt;'
      );
    });
  });
});
