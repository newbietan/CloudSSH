/**
 * SFTP 纯辅助函数集合：路径面包屑解析与条目排序逻辑。
 */

export interface PathBreadcrumb {
  name: string;
  path: string;
}

/**
 * 将远端绝对路径拆解为可逐级导航的面包屑节点。
 * 例如：'/var/log/nginx' ->
 *   [{ name: '/', path: '/' }, { name: 'var', path: '/var' }, { name: 'log', path: '/var/log' }, { name: 'nginx', path: '/var/log/nginx' }]
 */
export function parsePathBreadcrumbs(fullPath: string): PathBreadcrumb[] {
  const normalized = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
  const segments = normalized.split('/').filter(Boolean);

  const crumbs: PathBreadcrumb[] = [{ name: '/', path: '/' }];

  let current = '';
  for (const seg of segments) {
    current += `/${seg}`;
    crumbs.push({
      name: seg,
      path: current,
    });
  }

  return crumbs;
}

export type SFTPSortField = 'name' | 'size' | 'mtime';
export type SFTPSortDirection = 'asc' | 'desc';

export interface SFTPSortOptions {
  field: SFTPSortField;
  direction: SFTPSortDirection;
}

export interface SortableEntry {
  name: string;
  isDir: boolean;
  size?: number;
  modifiedTime?: number;
}

/**
 * 对 SFTP 条目进行排序：
 * - 目录始终优先置顶（保持常规文件管理器的体验）
 * - 根据 field（name/size/mtime）与 direction（asc/desc）排序
 * - 次级排序规则：当主字段相等时按文件名稳定升序
 */
export function sortSFTPEntries<T extends SortableEntry>(
  entries: T[],
  sort: SFTPSortOptions
): T[] {
  return [...entries].sort((a, b) => {
    // 目录始终置顶
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;

    let comp = 0;
    if (sort.field === 'name') {
      comp = a.name.localeCompare(b.name);
    } else if (sort.field === 'size') {
      const aSize = a.isDir ? 0 : (a.size ?? 0);
      const bSize = b.isDir ? 0 : (b.size ?? 0);
      comp = aSize - bSize;
    } else if (sort.field === 'mtime') {
      const aMtime = a.modifiedTime ?? 0;
      const bMtime = b.modifiedTime ?? 0;
      comp = aMtime - bMtime;
    }

    // 次级排序：名称稳定排序
    if (comp === 0) {
      return a.name.localeCompare(b.name);
    }

    return sort.direction === 'asc' ? comp : -comp;
  });
}
