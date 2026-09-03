/**
 * SFTP 交互对话框辅助模块（文件名校验、新建文件/目录、重命名、删除确认）。
 */
import { t } from './i18n';
import { confirmAction, requestText } from './ui-feedback';

/**
 * 校验远端文件名/目录名：不能为空，不能为 '.' 或 '..'，不能包含 '/' 或空字符。
 */
export function validateRemoteName(value: string): string | null {
  if (value === '.' || value === '..') return t('sftp.invalidName');
  if (value.includes('/') || value.includes('\0')) return t('sftp.invalidName');
  return null;
}

export async function promptNewFileName(): Promise<string | null> {
  return requestText({
    title: t('sftp.newFileTitle'),
    message: t('sftp.newFileMessage'),
    label: t('sftp.name'),
    placeholder: t('sftp.newFilePlaceholder'),
    confirmText: t('common.confirm'),
    cancelText: t('common.cancel'),
    maxLength: 255,
    validate: validateRemoteName,
  });
}

export async function promptMkdirName(): Promise<string | null> {
  return requestText({
    title: t('sftp.mkdirTitle'),
    message: t('sftp.mkdirMessage'),
    label: t('sftp.name'),
    placeholder: t('sftp.mkdirMessage'),
    confirmText: t('common.confirm'),
    cancelText: t('common.cancel'),
    maxLength: 255,
    validate: validateRemoteName,
  });
}

export async function promptRename(currentName: string): Promise<string | null> {
  return requestText({
    title: t('sftp.renameTitle'),
    message: t('sftp.renameMessage', { name: currentName }),
    label: t('sftp.name'),
    defaultValue: currentName,
    confirmText: t('sftp.rename'),
    cancelText: t('common.cancel'),
    maxLength: 255,
    validate: validateRemoteName,
  });
}

export async function confirmDeleteItems(names: string[]): Promise<boolean> {
  if (names.length === 0) return false;
  return confirmAction({
    title: t('sftp.deleteTitle'),
    message:
      names.length === 1
        ? t('sftp.deleteMessage', { name: names[0] })
        : t('sftp.deleteManyMessage', { count: names.length }),
    confirmText: t('common.delete'),
    cancelText: t('common.cancel'),
    variant: 'danger',
  });
}
