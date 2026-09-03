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

/**
 * 根据文件名后缀映射 Material Symbols 图标名称。
 */
export function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':
      return 'javascript';
    case 'py':
      return 'code';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'terminal';
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return 'data_object';
    case 'md':
    case 'txt':
    case 'log':
      return 'description';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return 'image';
    case 'mp4':
    case 'mkv':
    case 'avi':
    case 'mov':
      return 'movie';
    case 'mp3':
    case 'wav':
    case 'ogg':
      return 'audio_file';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'bz2':
    case 'xz':
    case '7z':
      return 'folder_zip';
    case 'pdf':
      return 'picture_as_pdf';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'go':
    case 'rs':
    case 'c':
    case 'h':
    case 'cpp':
    case 'hpp':
    case 'java':
    case 'kt':
    case 'rb':
    case 'php':
    case 'xml':
      return 'code';
    case 'sql':
      return 'database';
    case 'conf':
    case 'cfg':
    case 'ini':
    case 'env':
      return 'settings';
    default:
      return 'draft';
  }
}

/**
 * 格式化字节大小为易读字符串（B/KB/MB/GB）。
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 格式化时间戳为类似 ls -l 的日期时间字符串。
 */
export function formatTimestamp(unixTime: number): string {
  if (!unixTime) return '';

  const date = new Date(unixTime * 1000);
  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const pad = (n: number) => n.toString().padStart(2, '0');

  if (date > sixMonthsAgo) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${date.getFullYear()}`;
}

/**
 * HTML 特殊字符转义防 XSS。
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
