// SFTP v3 protocol constants (draft-ietf-secsh-filexfer-02)

// Packet types
export const SSH_FXP_INIT = 1;
export const SSH_FXP_VERSION = 2;
export const SSH_FXP_OPEN = 3;
export const SSH_FXP_CLOSE = 4;
export const SSH_FXP_READ = 5;
export const SSH_FXP_WRITE = 6;
export const SSH_FXP_LSTAT = 7;
export const SSH_FXP_FSTAT = 8;
export const SSH_FXP_SETSTAT = 9;
export const SSH_FXP_FSETSTAT = 10;
export const SSH_FXP_OPENDIR = 11;
export const SSH_FXP_READDIR = 12;
export const SSH_FXP_REMOVE = 13;
export const SSH_FXP_MKDIR = 14;
export const SSH_FXP_RMDIR = 15;
export const SSH_FXP_REALPATH = 16;
export const SSH_FXP_STAT = 17;
export const SSH_FXP_RENAME = 18;
export const SSH_FXP_READLINK = 19;
export const SSH_FXP_SYMLINK = 20;

// Status codes
export const SSH_FX_OK = 0;
export const SSH_FX_EOF = 1;
export const SSH_FX_NO_SUCH_FILE = 2;
export const SSH_FX_PERMISSION_DENIED = 3;
export const SSH_FX_FAILURE = 4;
export const SSH_FX_BAD_MESSAGE = 5;
export const SSH_FX_NO_CONNECTION = 6;
export const SSH_FX_CONNECTION_LOST = 7;
export const SSH_FX_OP_UNSUPPORTED = 8;

// Response types
export const SSH_FXP_STATUS = 101;
export const SSH_FXP_HANDLE = 102;
export const SSH_FXP_DATA = 103;
export const SSH_FXP_NAME = 104;
export const SSH_FXP_ATTRS = 105;

// File open flags
export const SSH_FXF_READ = 0x00000001;
export const SSH_FXF_WRITE = 0x00000002;
export const SSH_FXF_APPEND = 0x00000004;
export const SSH_FXF_CREAT = 0x00000008;
export const SSH_FXF_TRUNC = 0x00000010;
export const SSH_FXF_EXCL = 0x00000020;

// File attribute flags
export const SSH_FILEXFER_ATTR_SIZE = 0x00000001;
export const SSH_FILEXFER_ATTR_UIDGID = 0x00000002;
export const SSH_FILEXFER_ATTR_PERMISSIONS = 0x00000004;
export const SSH_FILEXFER_ATTR_ACMODTIME = 0x00000008;
export const SSH_FILEXFER_ATTR_EXTENDED = 0x80000000;

// File type constants (from permissions)
export const SSH_S_IFMT = 0o170000;
export const SSH_S_IFDIR = 0o040000;
export const SSH_S_IFLNK = 0o120000;
export const SSH_S_IFREG = 0o100000;

export interface SFTPFileAttributes {
  size?: number;
  uid?: number;
  gid?: number;
  permissions?: number;
  atime?: number;
  mtime?: number;
}

export interface SFTPFileEntry {
  filename: string;
  longname: string;
  attrs: SFTPFileAttributes;
}

export interface SFTPPendingRequest {
  requestId: number;
  type: number;
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export function getStatusMessage(code: number): string {
  switch (code) {
    case SSH_FX_OK: return '成功';
    case SSH_FX_EOF: return '已到文件末尾';
    case SSH_FX_NO_SUCH_FILE: return '文件不存在';
    case SSH_FX_PERMISSION_DENIED: return '权限被拒绝';
    case SSH_FX_FAILURE: return '操作失败';
    case SSH_FX_BAD_MESSAGE: return '消息格式错误';
    case SSH_FX_NO_CONNECTION: return '无连接';
    case SSH_FX_CONNECTION_LOST: return '连接丢失';
    case SSH_FX_OP_UNSUPPORTED: return '操作不支持';
    default: return `未知错误 (${code})`;
  }
}

export function getFileTypeFromPermissions(permissions: number): 'dir' | 'link' | 'file' {
  const mode = permissions & SSH_S_IFMT;
  if (mode === SSH_S_IFDIR) return 'dir';
  if (mode === SSH_S_IFLNK) return 'link';
  return 'file';
}

export function formatPermissions(permissions: number): string {
  const mode = permissions & 0o777;
  let result = '';
  // owner
  result += (mode & 0o400) ? 'r' : '-';
  result += (mode & 0o200) ? 'w' : '-';
  result += (mode & 0o100) ? 'x' : '-';
  // group
  result += (mode & 0o040) ? 'r' : '-';
  result += (mode & 0o020) ? 'w' : '-';
  result += (mode & 0o010) ? 'x' : '-';
  // other
  result += (mode & 0o004) ? 'r' : '-';
  result += (mode & 0o002) ? 'w' : '-';
  result += (mode & 0o001) ? 'x' : '-';
  return result;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}
