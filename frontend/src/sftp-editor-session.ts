/**
 * SFTP 在线编辑会话协调器（issue #116 / #117）。
 *
 * 负责在线编辑全生命周期：
 * - 读取流控制与二进制互斥
 * - 编码识别（UTF-8 可写 / GB18030 只读）与回退下载决策
 * - CodeMirror 实例挂载与视图销毁
 * - 保存前 mtime + size 远端 stat 冲突比对
 * - 通过既有上传队列覆盖写回
 */
import { openRemoteEditor, type RemoteEditorHandle } from './code-editor';
import {
  decodeEditorContent,
  encodeEditorContent,
  EDITOR_MAX_FILE_SIZE,
  isEditorSizeAllowed,
  type SupportedEncoding,
} from './editor-content';
import { formatSize } from './sftp-helpers';
import { Deferred } from './sftp-transfer';
import { t } from './i18n';
import { confirmAction, notify } from './ui-feedback';

const EDIT_READ_TIMEOUT_MS = 30000;
const STAT_TIMEOUT_MS = 15000;

export type EditReadErrorCode = 'binary' | 'too_large';

export function shouldFallbackToDownload(
  editErrorCode: EditReadErrorCode | undefined,
  decodeReason: 'binary' | 'encoding' | null
): boolean {
  return decodeReason !== null || editErrorCode !== undefined;
}

export interface EditorReadResult {
  ok: boolean;
  path: string;
  bytes: Uint8Array;
  mtime: number;
  size: number;
  errorMessage?: string;
  errorCode?: EditReadErrorCode;
}

export interface RemoteStatResult {
  ok: boolean;
  mtime: number;
  size: number;
}

export interface ActiveEditorSession {
  path: string;
  filename: string;
  encoding: SupportedEncoding;
  bom: boolean;
  eol: '\n' | '\r\n';
  mtime: number;
  size: number;
  handle: RemoteEditorHandle;
}

export interface SFTPEditorContext {
  isSftpReady: () => boolean;
  isVisible: () => boolean;
  sendJSON: (data: Record<string, unknown>) => void;
  enqueueUploadTask: (
    file: File,
    targetPath: string,
    options: { overwriteFirst: boolean; reportError: boolean }
  ) => Promise<boolean>;
  queueDownloadFile: (path: string, filename: string) => void;
  refresh: () => void;
  setStatus: (status: string) => void;
  setIdleStatus: (status: string) => void;
  getItemsStatus: () => string;
  showError: (message: string) => void;
}

export class SFTPEditorCoordinator {
  private activeEditor: ActiveEditorSession | null = null;
  private editReadActive = false;
  private editReadChunks: Uint8Array[] = [];
  private editReadMeta: { path: string; size: number; mtime: number } | null = null;
  private editReadWaiter: Deferred<EditorReadResult> | null = null;
  private editReadTimeout: ReturnType<typeof setTimeout> | null = null;
  private statWaiter: Deferred<RemoteStatResult> | null = null;
  private statTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: SFTPEditorContext) {}

  hasActiveEditor(): boolean {
    return this.activeEditor !== null;
  }

  getActiveEditor(): ActiveEditorSession | null {
    return this.activeEditor;
  }

  isEditReadActive(): boolean {
    return this.editReadActive;
  }

  hasPendingEditRead(): boolean {
    return this.editReadWaiter !== null;
  }

  handleBinaryData(data: Uint8Array): boolean {
    if (this.editReadActive) {
      this.editReadChunks.push(data);
      return true;
    }
    return false;
  }

  onEditStart(path: string, size: number, mtime: number): void {
    this.editReadMeta = { path, size, mtime };
    this.editReadChunks = [];
  }

  onEditDone(path: string, size: number, mtime: number): void {
    this.resolveEditRead({
      ok: true,
      path,
      bytes: this.concatEditChunks(),
      mtime,
      size,
    });
  }

  onEditError(message: string, code?: EditReadErrorCode, hadPending?: boolean): void {
    this.rejectEditRead(message, code);
    if (!hadPending) {
      this.ctx.showError(message);
    }
  }

  onStatAttrs(attrs: any): void {
    this.resolveStatWaiter(attrs);
  }

  onStatError(): void {
    if (this.statWaiter) {
      this.resolveStatWaiter(null);
    }
  }

  async openEditorForFile(
    path: string,
    filename: string,
    knownSize: number,
    options: { fallbackToDownload?: boolean } = {}
  ): Promise<void> {
    const fallbackToDownload = options.fallbackToDownload === true;
    if (this.activeEditor) {
      this.activeEditor.handle.focus();
      notify(t('sftp.editorAlreadyOpen'), { variant: 'warning' });
      return;
    }
    if (this.editReadActive) {
      notify(t('sftp.editorLoadingOther'), { variant: 'info' });
      return;
    }
    if (!isEditorSizeAllowed(knownSize)) {
      if (fallbackToDownload) {
        this.ctx.queueDownloadFile(path, filename);
        return;
      }
      notify(
        t('sftp.editorTooLarge', {
          name: filename,
          size: formatSize(knownSize),
          max: formatSize(EDITOR_MAX_FILE_SIZE),
        }),
        { variant: 'danger' }
      );
      return;
    }

    this.editReadActive = true;
    this.editReadChunks = [];
    this.editReadMeta = null;
    const waiter = new Deferred<EditorReadResult>();
    this.editReadWaiter = waiter;
    this.editReadTimeout = setTimeout(() => {
      if (this.editReadWaiter === waiter) {
        this.editReadWaiter = null;
        waiter.resolve({
          ok: false,
          path,
          bytes: new Uint8Array(0),
          mtime: 0,
          size: 0,
          errorMessage: t('sftp.editorLoadTimeout'),
        });
      }
    }, EDIT_READ_TIMEOUT_MS);
    this.ctx.setStatus(t('sftp.editorLoading', { name: filename }));

    try {
      this.ctx.sendJSON({ type: 'sftp_edit_read', path });
      const result = await waiter.promise;

      if (!result.ok) {
        if (result.errorMessage) {
          if (fallbackToDownload && shouldFallbackToDownload(result.errorCode, null)) {
            this.ctx.queueDownloadFile(path, filename);
            return;
          }
          notify(result.errorMessage, { variant: 'danger' });
        }
        return;
      }

      const decoded = decodeEditorContent(result.bytes);
      if (!decoded.ok) {
        if (fallbackToDownload && shouldFallbackToDownload(undefined, decoded.reason)) {
          this.ctx.queueDownloadFile(path, filename);
          return;
        }
        notify(
          decoded.reason === 'binary'
            ? t('sftp.editorBinary')
            : t('sftp.editorEncodingUnsupported'),
          { variant: 'warning' }
        );
        return;
      }

      const readOnly = decoded.content.encoding !== 'utf-8';
      const encodingLabel =
        decoded.content.encoding === 'gb18030'
          ? t('sftp.editorEncodingGb18030')
          : t('sftp.editorEncodingUtf8');
      const handle = openRemoteEditor({
        filename,
        path,
        content: decoded.content,
        readOnly,
        notice: readOnly ? t('sftp.editorReadOnlyNotice', { encoding: encodingLabel }) : undefined,
        onSave: () => this.saveActiveEditor(),
        onClose: () => {
          this.activeEditor = null;
          if (this.ctx.isVisible() && this.ctx.isSftpReady()) {
            this.ctx.refresh();
          }
        },
      });

      this.activeEditor = {
        path,
        filename,
        encoding: decoded.content.encoding,
        bom: decoded.content.bom,
        eol: decoded.content.eol,
        mtime: result.mtime,
        size: result.size,
        handle,
      };
    } catch (e) {
      notify(
        t('sftp.editorLoadFailed', { message: e instanceof Error ? e.message : String(e) }),
        { variant: 'danger' }
      );
    } finally {
      this.editReadActive = false;
      this.editReadChunks = [];
      this.editReadMeta = null;
      if (this.editReadTimeout) {
        clearTimeout(this.editReadTimeout);
        this.editReadTimeout = null;
      }
      this.ctx.setIdleStatus(this.ctx.getItemsStatus());
    }
  }

  async saveActiveEditor(): Promise<boolean> {
    const session = this.activeEditor;
    if (!session) return false;
    if (!this.ctx.isSftpReady()) {
      notify(t('sftp.editorSaveFailed', { message: t('sftp.disconnected') }), {
        variant: 'danger',
      });
      return false;
    }
    const content = session.handle.getContent();

    const remote = await this.statRemote(session.path);
    if (remote.ok) {
      if (remote.mtime !== session.mtime || remote.size !== session.size) {
        const overwrite = await confirmAction({
          title: t('sftp.editorRemoteChangedTitle'),
          message: t('sftp.editorRemoteChangedMessage', { name: session.filename }),
          confirmText: t('sftp.editorOverwrite'),
          cancelText: t('common.cancel'),
          variant: 'danger',
        });
        if (!overwrite) return false;
      }
    } else {
      const proceed = await confirmAction({
        title: t('sftp.editorUnverifiableTitle'),
        message: t('sftp.editorUnverifiableMessage', { name: session.filename }),
        confirmText: t('sftp.editorOverwrite'),
        cancelText: t('common.cancel'),
        variant: 'danger',
      });
      if (!proceed) return false;
    }

    const bytes = encodeEditorContent(content, { bom: session.bom, eol: session.eol });
    const file = new File([bytes], session.filename);
    const dirPath = session.path.slice(0, session.path.lastIndexOf('/')) || '/';
    let uploaded: boolean;
    try {
      uploaded = await this.ctx.enqueueUploadTask(file, dirPath, {
        overwriteFirst: true,
        reportError: false,
      });
    } catch (e) {
      notify(
        t('sftp.editorSaveFailed', { message: e instanceof Error ? e.message : String(e) }),
        { variant: 'danger' }
      );
      return false;
    }
    if (!uploaded) {
      notify(t('sftp.editorSaveFailed', { message: t('sftp.uploadCancelled') }), {
        variant: 'danger',
      });
      return false;
    }

    const after = await this.statRemote(session.path);
    if (after.ok) {
      session.mtime = after.mtime;
      session.size = after.size;
    } else {
      session.mtime = -1;
      session.size = -1;
    }
    session.handle.markSaved();
    notify(t('sftp.editorSaved', { name: session.filename }), { variant: 'success' });
    return true;
  }

  statRemote(path: string): Promise<RemoteStatResult> {
    if (this.statWaiter) {
      return Promise.resolve({ ok: false, mtime: 0, size: 0 });
    }
    const deferred = new Deferred<RemoteStatResult>();
    this.statWaiter = deferred;
    this.statTimeout = setTimeout(() => {
      if (this.statWaiter === deferred) {
        this.statWaiter = null;
        deferred.resolve({ ok: false, mtime: 0, size: 0 });
      }
    }, STAT_TIMEOUT_MS);
    void deferred.promise
      .then(() => this.clearStatTimeout())
      .catch(() => this.clearStatTimeout());
    this.ctx.sendJSON({ type: 'sftp_stat', path });
    return deferred.promise;
  }

  private clearStatTimeout(): void {
    if (this.statTimeout) {
      clearTimeout(this.statTimeout);
      this.statTimeout = null;
    }
  }

  private resolveStatWaiter(attrs: any): void {
    const waiter = this.statWaiter;
    this.statWaiter = null;
    this.clearStatTimeout();
    if (!waiter) return;
    if (attrs && typeof attrs === 'object') {
      waiter.resolve({
        ok: true,
        mtime: Number(attrs.modifiedTime) || 0,
        size: Number(attrs.size) || 0,
      });
    } else {
      waiter.resolve({ ok: false, mtime: 0, size: 0 });
    }
  }

  private resolveEditRead(result: EditorReadResult): void {
    const waiter = this.editReadWaiter;
    this.editReadWaiter = null;
    if (this.editReadTimeout) {
      clearTimeout(this.editReadTimeout);
      this.editReadTimeout = null;
    }
    waiter?.resolve(result);
  }

  private rejectEditRead(message: string, errorCode?: EditReadErrorCode): void {
    const waiter = this.editReadWaiter;
    this.editReadWaiter = null;
    if (this.editReadTimeout) {
      clearTimeout(this.editReadTimeout);
      this.editReadTimeout = null;
    }
    waiter?.resolve({
      ok: false,
      path: this.editReadMeta?.path || '',
      bytes: new Uint8Array(0),
      mtime: 0,
      size: 0,
      errorMessage: message,
      errorCode,
    });
  }

  private concatEditChunks(): Uint8Array {
    const totalBytes = this.editReadChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of this.editReadChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  closeActiveEditor(): void {
    if (this.activeEditor) {
      this.activeEditor.handle.close();
      this.activeEditor = null;
    }
  }

  resetEditState(): void {
    this.closeActiveEditor();
    if (this.editReadWaiter) {
      this.rejectEditRead(t('sftp.disconnected'));
    }
    if (this.statWaiter) {
      this.resolveStatWaiter(null);
    }
    this.editReadActive = false;
    this.editReadChunks = [];
    this.editReadMeta = null;
  }

  dispose(): void {
    this.resetEditState();
  }
}
