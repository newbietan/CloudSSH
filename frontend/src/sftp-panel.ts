import {
  type ActiveEditorSession,
  type EditReadErrorCode,
  SFTPEditorCoordinator,
  shouldFallbackToDownload,
} from './sftp-editor-session';
import { onLocaleChange, t, translateDocument } from './i18n';
import {
  escapeHtml,
  formatSize,
  formatTimestamp,
  getFileIcon,
  parsePathBreadcrumbs,
  sortSFTPEntries,
  type SFTPSortField,
  type SFTPSortOptions,
} from './sftp-helpers';
import { updateSelection } from './sftp-selection';
import { Deferred, UploadWaiter } from './sftp-transfer';
import {
  confirmDeleteItems,
  promptMkdirName,
  promptNewFileName,
  promptRename,
} from './sftp-dialogs';
import { confirmAction, notify } from './ui-feedback';

export interface SFTPFileEntry {
  name: string;
  type: 'dir' | 'link' | 'file';
  size: number;
  sizeFormatted: string;
  permissions: string;
  permissionsRaw: number;
  modifiedTime: number;
  isDir: boolean;
  isLink: boolean;
}

export type GetSFTPWebSocketUrlFn = () => string | null;

const UPLOAD_CHUNK_SIZE = 128 * 1024;
const UPLOAD_CONCURRENCY = 8;
const DOWNLOAD_URL_REVOKE_DELAY_MS = 1000;
const SFTP_HEARTBEAT_INTERVAL_MS = 30000;

export { shouldFallbackToDownload, type EditReadErrorCode };

export class SFTPPanel {
  private container: HTMLElement;
  private currentPath: string = '/';
  private entries: SFTPFileEntry[] = [];
  private renderedEntries: SFTPFileEntry[] = [];
  private sortOptions: SFTPSortOptions = { field: 'name', direction: 'asc' };
  private selectedEntries: Map<string, SFTPFileEntry> = new Map();
  private selectionAnchorIndex: number | null = null;
  private pendingDeleteCount = 0;
  private getWebSocketUrl: GetSFTPWebSocketUrlFn;
  private ws: WebSocket | null = null;
  private connectingPromise: Promise<void> | null = null;
  private sftpWsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSends: (string | ArrayBuffer | Uint8Array)[] = [];
  private closedByPanel: WeakSet<WebSocket> = new WeakSet();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private visible: boolean = false;
  private initializing: boolean = false;
  private sftpReady: boolean = false;
  private downloadChunks: Uint8Array[] = [];
  private downloadFilename: string = '';
  private uploadCancelRequested: boolean = false;
  private uploadCancelConfirmed: boolean = false;
  private uploadCancelWaiter: Deferred<void> | null = null;
  private uploadWaiter = new UploadWaiter();
  private uploadQueueTail: Promise<void> = Promise.resolve();
  private uploadQueuePending: number = 0;
  private uploadQueuedFiles: number = 0;
  private uploadActive: boolean = false;
  private uploadQueueGeneration: number = 0;
  private downloadWaiter: Deferred<void> | null = null;
  private downloadQueueTail: Promise<void> = Promise.resolve();
  private downloadQueuePending: number = 0;
  private downloadQueuedFiles: number = 0;
  private downloadActive: boolean = false;
  private downloadCancelRequested: boolean = false;
  private downloadQueueGeneration: number = 0;
  private readonly editorCoordinator: SFTPEditorCoordinator;

  get activeEditor(): ActiveEditorSession | null {
    return this.editorCoordinator.getActiveEditor();
  }
  private localeCleanup: (() => void) | null = null;
  private readonly keydownHandler = (e: KeyboardEvent): void => {
    if (!this.visible || document.querySelector('dialog[open]')) return;
    const target = e.target as HTMLElement | null;
    const isEditable = target?.matches('input, textarea, select, [contenteditable="true"]');
    if ((e.ctrlKey || e.metaKey) && e.key.toLocaleLowerCase() === 'a' && !isEditable) {
      e.preventDefault();
      this.selectAllEntries();
    } else if (e.key === 'Escape' && this.selectedEntries.size > 0) {
      e.preventDefault();
      this.clearSelection();
    } else if (e.key === 'Escape') {
      this.hide();
    }
  };

  constructor(getWebSocketUrl: GetSFTPWebSocketUrlFn) {
    this.getWebSocketUrl = getWebSocketUrl;
    this.container = this.createPanel();
    document.body.appendChild(this.container);

    this.editorCoordinator = new SFTPEditorCoordinator({
      isSftpReady: () => this.sftpReady,
      isVisible: () => this.visible,
      sendJSON: (data) => this.sendJSON(data),
      // 编辑器保存路径显式声明 options.overwriteFirst: true（由 SFTPEditorCoordinator 执行）
      enqueueUploadTask: (file, path, opts) => this.enqueueUploadTask(file, path, opts),
      queueDownloadFile: (path, filename) => this.queueDownloadFile(path, filename),
      refresh: () => this.refresh(),
      setStatus: (s) => this.setStatus(s),
      setIdleStatus: (s) => this.setIdleStatus(s),
      getItemsStatus: () => this.getItemsStatus(),
      showError: (msg) => this.showError(msg),
    });

    this.localeCleanup = onLocaleChange(() => {
      translateDocument(this.container);
      this.hideContextMenu();
    });
    this.bindKeyboard();
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'sftp-panel';
    panel.className =
      'fixed top-0 right-0 h-full z-[90] flex transition-transform duration-300 ease-in-out';
    panel.style.width = 'min(clamp(420px, 40vw, 600px), 100vw)';
    panel.style.transform = 'translateX(100%)';

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    panel.innerHTML = `
      <div class="flex flex-col w-full h-full bg-surface border-l border-outline-variant text-on-surface">
        <!-- Header -->
        <div class="sftp-panel-header flex items-center justify-between px-4 h-12 border-b border-outline-variant bg-elevated shrink-0">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary-container" style="font-size: 18px; font-variation-settings: 'FILL' 1;">folder_open</span>
            <span class="text-xs font-bold tracking-[0.1em] text-primary-container" data-i18n="sftp.title">SFTP 文件管理器</span>
          </div>
          <button id="sftp-close-btn" class="hover:opacity-80 transition-opacity cursor-pointer p-1 text-on-surface-variant" data-i18n-title="sftp.close" title="关闭 SFTP 面板">
            <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
          </button>
        </div>

        <!-- Toolbar -->
        <div class="sftp-panel-toolbar flex items-center gap-2 px-3 py-2 border-b border-outline-variant bg-surface shrink-0">
          <button id="sftp-back-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer shrink-0" data-i18n-title="sftp.back" title="返回上一级">
            <span class="material-symbols-outlined" style="font-size: 18px;">arrow_back</span>
          </button>
          <button id="sftp-home-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer shrink-0" data-i18n-title="sftp.home" title="主目录">
            <span class="material-symbols-outlined" style="font-size: 18px;">home</span>
          </button>
          <button id="sftp-refresh-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer shrink-0" data-i18n-title="sftp.refresh" title="刷新">
            <span class="material-symbols-outlined" style="font-size: 18px;">refresh</span>
          </button>
          <div id="sftp-path-bar" class="flex-1 relative flex items-center min-w-0 h-[28px] rounded border border-outline-variant bg-surface-variant/20 focus-within:border-primary-container overflow-hidden">
            <div id="sftp-breadcrumbs" class="flex items-center gap-0.5 px-2 text-[12px] overflow-x-auto no-scrollbar w-full h-full select-none cursor-text"></div>
            <input id="sftp-path-input" class="hidden w-full h-full bg-transparent px-2 text-[12px] font-code outline-none terminal-input border-0" type="text" value="/" />
          </div>
          <button id="sftp-go-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer text-primary-container shrink-0" data-i18n-title="sftp.go" title="前往">
            <span class="material-symbols-outlined" style="font-size: 18px;">arrow_forward</span>
          </button>
        </div>

        <!-- Actions Bar -->
        <div class="sftp-panel-actions flex items-center gap-1 px-3 py-1.5 border-b border-outline-variant bg-surface shrink-0 overflow-x-auto no-scrollbar">
          <button id="sftp-upload-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-primary-container" data-i18n-title="sftp.upload" title="上传文件">
            <span class="material-symbols-outlined" style="font-size: 14px;">upload_file</span>
            <span data-i18n="sftp.uploadAction">上传文件</span>
          </button>
          <button id="sftp-new-file-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-primary-container" data-i18n-title="sftp.newFile" title="新建文件">
            <span class="material-symbols-outlined" style="font-size: 14px;">note_add</span>
            <span data-i18n="sftp.newFileAction">新建文件</span>
          </button>
          <button id="sftp-mkdir-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-secondary-container" data-i18n-title="sftp.newFolder" title="新建文件夹">
            <span class="material-symbols-outlined" style="font-size: 14px;">create_new_folder</span>
            <span data-i18n="sftp.mkdirAction">新建文件夹</span>
          </button>
          <button id="sftp-download-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-on-surface-variant disabled:opacity-30" data-i18n-title="sftp.download" title="下载" disabled>
            <span class="material-symbols-outlined" style="font-size: 14px;">download</span>
            <span data-i18n="sftp.downloadAction">下载</span>
          </button>
          <button id="sftp-edit-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-on-surface-variant disabled:opacity-30" data-i18n-title="sftp.edit" title="在线编辑" disabled>
            <span class="material-symbols-outlined" style="font-size: 14px;">edit_note</span>
            <span data-i18n="sftp.editAction">编辑</span>
          </button>
          <button id="sftp-delete-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-error-container rounded transition-colors cursor-pointer text-error disabled:opacity-30" data-i18n-title="common.delete" title="删除" disabled>
            <span class="material-symbols-outlined" style="font-size: 14px;">delete</span>
            <span data-i18n="sftp.deleteAction">删除</span>
          </button>
          <button id="sftp-rename-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-on-surface-variant disabled:opacity-30" data-i18n-title="sftp.rename" title="重命名" disabled>
            <span class="material-symbols-outlined" style="font-size: 14px;">drive_file_rename_outline</span>
            <span data-i18n="sftp.renameAction">重命名</span>
          </button>
          <input type="file" id="sftp-file-input" class="hidden" multiple />
        </div>

        <!-- Progress Bar -->
        <div id="sftp-progress-container" class="hidden px-3 py-1.5 border-b border-outline-variant bg-surface shrink-0">
          <div class="flex items-center justify-between text-[11px] mb-1">
            <span id="sftp-progress-text" class="text-on-surface-variant truncate"></span>
            <div class="flex items-center gap-2 shrink-0">
              <span id="sftp-progress-percent" class="text-primary-container font-bold"></span>
              <button id="sftp-transfer-cancel-btn" class="text-error hover:opacity-80 cursor-pointer flex items-center justify-center" data-i18n-title="sftp.cancelTransfer" title="取消传输">
                <span class="material-symbols-outlined" style="font-size: 14px;">close</span>
              </button>
            </div>
          </div>
          <div class="w-full h-1.5 bg-surface-variant rounded-full overflow-hidden">
            <div id="sftp-progress-bar" class="h-full bg-primary-container rounded-full transition-all duration-200" style="width: 0%"></div>
          </div>
        </div>

        <!-- Table Header (Sortable) -->
        <div id="sftp-table-header" class="flex items-center gap-2 px-3 py-1.5 border-b border-outline-variant bg-surface-variant/20 text-[11px] font-medium text-on-surface-variant select-none shrink-0">
          <button id="sftp-sort-name" type="button" class="flex-1 flex items-center gap-1 hover:text-primary-container cursor-pointer transition-colors text-left" data-i18n-title="sftp.sortByName" title="按名称排序">
            <span data-i18n="sftp.name">名称</span>
            <span class="sftp-sort-icon material-symbols-outlined text-[14px]">arrow_upward</span>
          </button>
          <button id="sftp-sort-size" type="button" class="w-16 flex items-center justify-end gap-1 hover:text-primary-container cursor-pointer transition-colors text-right shrink-0" data-i18n-title="sftp.sortBySize" title="按大小排序">
            <span data-i18n="sftp.size">大小</span>
            <span class="sftp-sort-icon material-symbols-outlined text-[14px] hidden"></span>
          </button>
          <span class="w-20 text-right shrink-0 hidden md:block" data-i18n="sftp.permissions">权限</span>
          <button id="sftp-sort-mtime" type="button" class="w-24 flex items-center justify-end gap-1 hover:text-primary-container cursor-pointer transition-colors text-right shrink-0 hidden lg:flex" data-i18n-title="sftp.sortByModified" title="按修改时间排序">
            <span data-i18n="sftp.modified">修改时间</span>
            <span class="sftp-sort-icon material-symbols-outlined text-[14px] hidden"></span>
          </button>
        </div>

        <!-- File List -->
        <div id="sftp-file-list" class="flex-1 overflow-y-auto custom-scrollbar">
          <!-- Loading -->
          <div id="sftp-loading" class="hidden flex items-center justify-center py-12">
            <div class="animate-spin rounded-full h-6 w-6 border-2 border-primary-container border-t-transparent"></div>
          </div>
          <!-- Empty state -->
          <div id="sftp-empty" class="hidden flex flex-col items-center justify-center py-12 text-on-surface-variant">
            <span class="material-symbols-outlined mb-2" style="font-size: 36px; font-variation-settings: 'FILL' 0;">folder_off</span>
            <span class="text-xs tracking-wider" data-i18n="sftp.empty">此目录为空</span>
          </div>
          <!-- Error state -->
          <div id="sftp-error" class="hidden flex flex-col items-center justify-center py-8 px-4 text-error">
            <span class="material-symbols-outlined mb-2" style="font-size: 28px;">error</span>
            <span id="sftp-error-text" class="text-xs text-center"></span>
          </div>
          <!-- Truncated warning -->
          <div id="sftp-truncated-warning" class="hidden flex items-center justify-center py-2 px-3 bg-tertiary-container text-on-tertiary-container text-xs mb-2 rounded mx-2 mt-2">
            <span class="material-symbols-outlined mr-2" style="font-size: 16px;">warning</span>
            <span data-i18n="sftp.truncated">该目录文件过多，为保证性能，仅显示前 2000 项。</span>
          </div>
          <!-- Entries will be rendered here -->
          <div id="sftp-entries" role="listbox" aria-multiselectable="true"></div>
        </div>

        <!-- Status Bar -->
        <div class="flex items-center justify-between px-3 py-1.5 border-t border-outline-variant bg-elevated text-[10px] text-on-surface-variant shrink-0">
          <span id="sftp-status-text" data-i18n="sftp.ready">就绪</span>
          <span id="sftp-item-count"></span>
        </div>
      </div>
    `;

    translateDocument(panel);

    return panel;
  }

  private bindKeyboard(): void {
    document.addEventListener('keydown', this.keydownHandler);
  }

  bindEvents(): void {
    const closeBtn = this.container.querySelector('#sftp-close-btn')!;
    const backBtn = this.container.querySelector('#sftp-back-btn')!;
    const homeBtn = this.container.querySelector('#sftp-home-btn')!;
    const refreshBtn = this.container.querySelector('#sftp-refresh-btn')!;
    const goBtn = this.container.querySelector('#sftp-go-btn')!;
    const uploadBtn = this.container.querySelector('#sftp-upload-btn')!;
    const newFileBtn = this.container.querySelector('#sftp-new-file-btn')!;
    const mkdirBtn = this.container.querySelector('#sftp-mkdir-btn')!;
    const downloadBtn = this.container.querySelector('#sftp-download-btn')!;
    const editBtn = this.container.querySelector('#sftp-edit-btn')!;
    const deleteBtn = this.container.querySelector('#sftp-delete-btn')!;
    const renameBtn = this.container.querySelector('#sftp-rename-btn')!;
    const cancelTransferBtn = this.container.querySelector('#sftp-transfer-cancel-btn')!;
    const fileInput = this.container.querySelector('#sftp-file-input') as HTMLInputElement;
    const pathInput = this.container.querySelector('#sftp-path-input') as HTMLInputElement;
    const pathBar = this.container.querySelector('#sftp-path-bar');

    closeBtn.addEventListener('click', () => this.hide());
    backBtn.addEventListener('click', () => this.goBack());
    homeBtn.addEventListener('click', () => this.navigate('~'));
    refreshBtn.addEventListener('click', () => this.refresh());
    goBtn.addEventListener('click', () => {
      this.navigate(pathInput.value);
      this.showBreadcrumbs();
    });
    pathBar?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sftp-crumb-item')) return;
      this.showPathInput();
    });
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.navigate(pathInput.value);
        this.showBreadcrumbs();
      } else if (e.key === 'Escape') {
        this.showBreadcrumbs();
      }
    });
    pathInput.addEventListener('blur', () => {
      this.showBreadcrumbs();
    });

    uploadBtn.addEventListener('click', () => fileInput.click());
    newFileBtn.addEventListener('click', () => this.showNewFileDialog());
    mkdirBtn.addEventListener('click', () => this.showMkdirDialog());
    downloadBtn.addEventListener('click', () => this.downloadSelected());
    editBtn.addEventListener('click', () => this.editSelected());
    deleteBtn.addEventListener('click', () => this.deleteSelected());
    renameBtn.addEventListener('click', () => this.showRenameDialog());
    cancelTransferBtn.addEventListener('click', () => this.cancelCurrentTransfer());

    const sortNameBtn = this.container.querySelector('#sftp-sort-name');
    const sortSizeBtn = this.container.querySelector('#sftp-sort-size');
    const sortMtimeBtn = this.container.querySelector('#sftp-sort-mtime');
    sortNameBtn?.addEventListener('click', () => this.toggleSort('name'));
    sortSizeBtn?.addEventListener('click', () => this.toggleSort('size'));
    sortMtimeBtn?.addEventListener('click', () => this.toggleSort('mtime'));

    this.renderBreadcrumbs(this.currentPath);

    fileInput.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.queueUploadFiles(Array.from(files));
      }
      fileInput.value = '';
    });

    // Drag-and-drop on the file list
    const fileList = this.container.querySelector('#sftp-file-list')!;
    fileList.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileList.classList.add('bg-surface-variant');
    });
    fileList.addEventListener('dragleave', (e) => {
      e.preventDefault();
      fileList.classList.remove('bg-surface-variant');
    });
    fileList.addEventListener('drop', (e: Event) => {
      const de = e as DragEvent;
      de.preventDefault();
      de.stopPropagation();
      fileList.classList.remove('bg-surface-variant');
      const files = de.dataTransfer?.files;
      if (files && files.length > 0) {
        this.queueUploadFiles(Array.from(files));
      }
    });
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.container.style.transform = 'translateX(0)';

    if (!this.sftpReady && !this.initializing) {
      this.initializing = true;
      this.sendJSON({ type: 'sftp_init' });
      this.showLoading();
    }
  }

  hide(): void {
    this.closeActiveEditor();
    this.resetEditState();
    this.resetUploadQueue();
    this.resetDownloadQueue();
    this.visible = false;
    this.container.style.transform = 'translateX(100%)';
    this.sendJSON({ type: 'sftp_close' });
    this.closeWebSocket(1000, 'SFTP panel hidden');
    this.initializing = false;
    this.sftpReady = false;
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  handleSSHReady(): void {
    this.closeWebSocket(1000, 'SSH session refreshed');
    this.closeActiveEditor();
    this.resetEditState();
    this.resetUploadQueue();
    this.resetDownloadQueue();
    this.uploadWaiter.reset();
    this.sftpReady = false;
    this.downloadChunks = [];
    this.downloadFilename = '';
    this.hideProgress();
    this.hideError();

    if (!this.visible) {
      this.initializing = false;
      return;
    }

    this.initializing = true;
    this.showLoading();
    this.setStatus(t('sftp.reconnecting'));
    this.sendJSON({ type: 'sftp_init' });
  }

  private sendJSON(msg: any): void {
    this.sendRaw(JSON.stringify(msg));
  }

  private sendBinary(data: ArrayBuffer | Uint8Array): void {
    this.sendRaw(data);
  }

  private sendRaw(data: string | ArrayBuffer | Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return;
    }

    this.pendingSends.push(data);
    void this.ensureWebSocket();
  }

  private async ensureWebSocket(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.flushPendingSends();
      return;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    const wsUrl = this.getWebSocketUrl();
    if (!wsUrl) {
      this.setStatus(t('sftp.waitingWebSocket'));
      if (!this.sftpWsRetryTimer) {
        this.sftpWsRetryTimer = setTimeout(() => {
          this.sftpWsRetryTimer = null;
          void this.ensureWebSocket();
        }, 200);
      }
      return;
    }

    this.connectingPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.connectingPromise = null;
        this.startHeartbeat();
        this.flushPendingSends();
        resolve();
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            this.handleMessage(JSON.parse(event.data));
          } catch {
            this.showError(t('sftp.invalidResponse'));
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryData(new Uint8Array(event.data));
        }
      };

      ws.onerror = () => {
        const message = t('sftp.websocketError');
        this.stopHeartbeat();
        this.connectingPromise = null;
        this.initializing = false;
        this.sftpReady = false;
        this.pendingSends = [];
        this.rejectUploadWaiter(message);
        this.rejectDownloadWaiter(message);
        this.showError(message);
        reject(new Error(message));
      };

      ws.onclose = () => {
        this.stopHeartbeat();
        if (this.ws === ws) {
          this.ws = null;
        }
        this.connectingPromise = null;

        if (!this.closedByPanel.has(ws)) {
          const message = t('sftp.connectionClosed');
          this.initializing = false;
          this.sftpReady = false;
          this.pendingSends = [];
          this.rejectUploadWaiter(message);
          this.rejectDownloadWaiter(message);
          if (this.visible) this.showError(message);
        }
      };
    });

    try {
      await this.connectingPromise;
    } catch {
      // The error is already reflected in the panel UI.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, SFTP_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private flushPendingSends(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const item of pending) {
      this.ws.send(item);
    }
  }

  private closeWebSocket(code?: number, reason?: string): void {
    this.stopHeartbeat();
    if (this.sftpWsRetryTimer) {
      clearTimeout(this.sftpWsRetryTimer);
      this.sftpWsRetryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.connectingPromise = null;
    this.pendingSends = [];
    this.sftpReady = false;

    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      this.closedByPanel.add(ws);
      try {
        ws.close(code, reason);
      } catch {
        /* 连接可能已关闭，close 抛出可忽略（幂等操作） */
      }
    }
  }

  // Handle messages from the backend
  handleMessage(msg: any): void {
    switch (msg.type) {
      case 'sftp_ready':
        this.initializing = false;
        this.sftpReady = true;
        this.navigate('~');
        break;
      case 'sftp_list_result':
        this.onListResult(msg.path, msg.entries, msg.isTruncated);
        break;
      case 'sftp_stat_result':
        this.editorCoordinator.onStatAttrs(msg.attrs);
        break;
      case 'pong':
        break;
      case 'sftp_download_start':
        this.onDownloadStart(msg.filename);
        break;
      case 'sftp_edit_start':
        this.editorCoordinator.onEditStart(
          typeof msg.path === 'string' ? msg.path : '',
          Number(msg.size) || 0,
          Number(msg.mtime) || 0
        );
        break;
      case 'sftp_edit_done':
        this.editorCoordinator.onEditDone(
          typeof msg.path === 'string' ? msg.path : '',
          Number(msg.size) || 0,
          Number(msg.mtime) || 0
        );
        break;
      case 'sftp_download_progress':
        this.onDownloadProgress(msg.loaded, msg.total);
        break;
      case 'sftp_download_done':
        this.onDownloadDone(msg.filename);
        break;
      case 'sftp_download_cancelled':
        this.onDownloadCancelled();
        break;
      case 'sftp_upload_ready':
        this.onUploadReady();
        break;
      case 'sftp_upload_conflict':
        this.uploadWaiter.resolveConflict({
          path: msg.path,
          existingSize: Number.isFinite(msg.existingSize) ? msg.existingSize : 0,
        });
        break;
      case 'sftp_upload_progress':
        this.onUploadProgress(msg.loaded, msg.total);
        break;
      case 'sftp_upload_complete':
        this.onUploadComplete(msg.path);
        break;
      case 'sftp_upload_cancelled':
        this.onUploadCancelled();
        break;
      case 'sftp_delete_result':
        this.onDeleteResult(msg.path);
        break;
      case 'sftp_rename_result':
        this.onRenameResult();
        break;
      case 'sftp_mkdir_result':
        this.onMkdirResult(msg.path);
        break;
      case 'sftp_rmdir_result':
        this.onDeleteResult(msg.path);
        break;
      case 'sftp_closed': {
        const message = t('sftp.connectionClosed');
        this.initializing = false;
        this.sftpReady = false;
        this.rejectUploadWaiter(message);
        this.rejectDownloadWaiter(message);
        if (this.visible) {
          this.showError(message);
        }
        break;
      }
      case 'sftp_error':
        this.handleSFTPError(msg);
        break;
    }
  }

  private handleSFTPError(msg: any): void {
    const operation = typeof msg.operation === 'string' ? msg.operation : '';

    // 编辑器打开失败：由 openEditorForFile 统一 notify，避免双重报错；
    // 无待决请求时才落到面板错误横幅
    if (operation === 'edit') {
      const hadPending = this.editorCoordinator.hasPendingEditRead();
      const message = typeof msg.message === 'string' ? msg.message : '';
      const code = msg.code === 'binary' || msg.code === 'too_large' ? msg.code : undefined;
      this.editorCoordinator.onEditError(message, code, hadPending);
      return;
    }

    if (operation === 'stat') {
      this.editorCoordinator.onStatError();
    }

    if (operation === 'init' || !this.sftpReady) {
      this.initializing = false;
      if (operation === 'init') {
        this.sftpReady = false;
      }
    }

    if (operation === 'upload') {
      this.rejectUploadWaiter(msg.message);
    }

    if (operation === 'download') {
      this.rejectDownloadWaiter(msg.message);
    }
    if ((operation === 'delete' || operation === 'rmdir') && this.pendingDeleteCount > 0) {
      this.pendingDeleteCount--;
      if (this.pendingDeleteCount === 0) {
        this.clearSelection();
        this.refresh();
      }
    }

    this.showError(msg.message);

    if (operation === 'upload' || operation === 'download' || operation === 'init') {
      this.hideProgress();
    }
  }

  // Handle binary data (download chunks)
  handleBinaryData(data: Uint8Array): void {
    // 在线编辑读取与下载互斥使用同一条二进制流：编辑读取优先路由
    if (this.editorCoordinator.handleBinaryData(data)) {
      return;
    }
    if (this.downloadFilename) {
      this.downloadChunks.push(data);
    }
  }

  // Navigation
  private navigate(path: string): void {
    this.showLoading();
    this.clearSelection();
    this.sendJSON({ type: 'sftp_list', path });
  }

  private refresh(): void {
    if (!this.sftpReady) {
      if (this.initializing) return;
      this.initializing = true;
      this.sendJSON({ type: 'sftp_init' });
      this.showLoading();
      return;
    }

    this.navigate(this.currentPath);
  }

  private goBack(): void {
    const parts = this.currentPath.split('/').filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    this.navigate('/' + parts.join('/') || '/');
  }

  // Directory listing results
  private onListResult(path: string, entries: SFTPFileEntry[], isTruncated?: boolean): void {
    this.currentPath = path;
    this.entries = entries;

    const pathInput = this.container.querySelector('#sftp-path-input') as HTMLInputElement;
    if (pathInput) pathInput.value = path;
    this.renderBreadcrumbs(path);

    const warningEl = this.container.querySelector('#sftp-truncated-warning');
    if (warningEl) {
      if (isTruncated) {
        warningEl.classList.remove('hidden');
      } else {
        warningEl.classList.add('hidden');
      }
    }

    this.renderEntries();
    this.hideLoading();
    this.hideError();
    this.setIdleStatus(this.getItemsStatus());
    this.updateItemCount(entries.length);
  }

  // Render file entries
  private renderEntries(): void {
    const entriesContainer = this.container.querySelector('#sftp-entries')!;
    const emptyState = this.container.querySelector('#sftp-empty')!;

    if (this.entries.length === 0) {
      entriesContainer.innerHTML = '';
      emptyState.classList.remove('hidden');
      emptyState.classList.add('flex');
      return;
    }

    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');

    // Sort: directories first, then by chosen sortOptions
    const sorted = sortSFTPEntries(this.entries, this.sortOptions);
    this.renderedEntries = sorted;

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    entriesContainer.innerHTML = sorted
      .map(
        (entry, idx) => `
      <div class="sftp-entry flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant cursor-pointer transition-colors border-b border-outline-variant/30 text-[12px]"
           data-idx="${idx}" data-name="${this.escapeHtml(entry.name)}" data-type="${entry.type}"
           role="option" aria-selected="${this.selectedEntries.has(entry.name)}" tabindex="-1">
        <span class="material-symbols-outlined shrink-0 ${entry.isDir ? 'text-primary-container' : entry.isLink ? 'text-secondary-container' : 'text-on-surface-variant'}"
              style="font-size: 16px; font-variation-settings: 'FILL' ${entry.isDir ? '1' : '0'};">
          ${entry.isDir ? 'folder' : entry.isLink ? 'link' : this.getFileIcon(entry.name)}
        </span>
        <span class="flex-1 truncate ${entry.isDir ? 'text-primary-container font-bold' : 'text-on-surface'}" title="${this.escapeHtml(entry.name)}">
          ${this.escapeHtml(entry.name)}
        </span>
        <span class="text-on-surface-variant text-[11px] w-16 text-right shrink-0">${entry.isDir ? '-' : entry.sizeFormatted}</span>
        <span class="text-on-surface-variant text-[10px] w-20 text-right shrink-0 hidden md:block">${entry.permissions}</span>
        <span class="text-on-surface-variant text-[10px] w-24 text-right shrink-0 hidden lg:block">${this.formatTimestamp(entry.modifiedTime)}</span>
      </div>
    `
      )
      .join('');

    // Bind click events
    entriesContainer.querySelectorAll('.sftp-entry').forEach((el) => {
      el.addEventListener('click', (e) => {
        const target = el as HTMLElement;
        const idx = parseInt(target.dataset.idx!, 10);
        this.selectEntry(idx, {
          additive: (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey,
          range: (e as MouseEvent).shiftKey,
        });
      });

      el.addEventListener('dblclick', () => {
        const target = el as HTMLElement;
        const idx = parseInt(target.dataset.idx!, 10);
        const entry = sorted[idx];
        if (entry.isDir) {
          this.navigate(
            this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`
          );
          return;
        }
        // 双击智能“打开”：可编辑候选先尝试编辑器，明确不可编辑（超大/二进制/无法解码）时自动转下载
        const path =
          this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
        void this.openEditorForFile(path, entry.name, entry.size, { fallbackToDownload: true });
      });

      // Right-click context menu
      el.addEventListener('contextmenu', (e: Event) => {
        const me = e as MouseEvent;
        me.preventDefault();
        const target = el as HTMLElement;
        const idx = parseInt(target.dataset.idx!, 10);
        const entry = sorted[idx];
        if (!this.selectedEntries.has(entry.name)) {
          this.selectEntry(idx, { additive: false, range: false });
        }
        this.showContextMenu(me.clientX, me.clientY, entry);
      });
    });
    this.syncSelectionUI();
  }

  private selectEntry(index: number, options: { additive: boolean; range: boolean }): void {
    const selectedIndices = new Set<number>();
    this.renderedEntries.forEach((entry, entryIndex) => {
      if (this.selectedEntries.has(entry.name)) selectedIndices.add(entryIndex);
    });
    const result = updateSelection(
      selectedIndices,
      index,
      this.selectionAnchorIndex,
      this.renderedEntries.length,
      options
    );
    this.selectionAnchorIndex = result.anchor;
    this.selectedEntries.clear();
    result.selected.forEach((selectedIndex) => {
      const entry = this.renderedEntries[selectedIndex];
      if (entry) this.selectedEntries.set(entry.name, entry);
    });
    this.syncSelectionUI();
    this.updateActionButtons();
  }

  private clearSelection(): void {
    this.selectedEntries.clear();
    this.selectionAnchorIndex = null;
    this.syncSelectionUI();
    this.updateActionButtons();
  }

  private selectAllEntries(): void {
    this.selectedEntries = new Map(this.renderedEntries.map((entry) => [entry.name, entry]));
    this.selectionAnchorIndex =
      this.renderedEntries.length > 0 ? this.renderedEntries.length - 1 : null;
    this.syncSelectionUI();
    this.updateActionButtons();
  }

  private syncSelectionUI(): void {
    this.container.querySelectorAll<HTMLElement>('.sftp-entry').forEach((element) => {
      const selected = this.selectedEntries.has(element.dataset.name || '');
      element.classList.toggle('bg-surface-variant', selected);
      element.setAttribute('aria-selected', String(selected));
    });
  }

  private updateActionButtons(): void {
    const downloadBtn = this.container.querySelector('#sftp-download-btn') as HTMLButtonElement;
    const editBtn = this.container.querySelector('#sftp-edit-btn') as HTMLButtonElement;
    const deleteBtn = this.container.querySelector('#sftp-delete-btn') as HTMLButtonElement;
    const renameBtn = this.container.querySelector('#sftp-rename-btn') as HTMLButtonElement;

    const selected = [...this.selectedEntries.values()];
    const hasSelection = selected.length > 0;
    downloadBtn.disabled = !selected.some((entry) => !entry.isDir);
    editBtn.disabled = !(selected.length === 1 && !selected[0].isDir);
    deleteBtn.disabled = !hasSelection;
    renameBtn.disabled = selected.length !== 1;
    this.setIdleStatus(
      hasSelection ? t('sftp.selectedCount', { count: selected.length }) : this.getItemsStatus()
    );
  }

  private showContextMenu(x: number, y: number, entry: SFTPFileEntry): void {
    this.hideContextMenu();

    const menu = document.createElement('div');
    menu.id = 'sftp-context-menu';
    menu.className =
      'fixed z-[200] bg-elevated border border-outline-variant shadow-lg py-1 text-[12px]';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const selected = [...this.selectedEntries.values()];
    const items: Array<{ label: string; icon: string; action: () => void; className?: string }> =
      [];
    if (selected.length === 1) {
      items.push({
        label: t('sftp.contextOpen'),
        icon: 'open_in_new',
        action: () => {
          if (entry.isDir) {
            this.navigate(
              this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`
            );
          } else {
            this.downloadEntries([entry]);
          }
        },
      });
      if (!entry.isDir) {
        items.push({
          label: t('sftp.contextEdit'),
          icon: 'edit_note',
          action: () => {
            void this.openEditorForFile(
              this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`,
              entry.name,
              entry.size
            );
          },
        });
      }
    }
    if (selected.some((selectedEntry) => !selectedEntry.isDir)) {
      items.push({
        label: t('sftp.contextDownload'),
        icon: 'download',
        action: () => this.downloadSelected(),
      });
    }
    if (selected.length === 1) {
      items.push({
        label: t('sftp.contextRename'),
        icon: 'drive_file_rename_outline',
        action: () => {
          void this.showRenameDialog();
        },
      });
    }
    items.push({
      label: t('sftp.contextDelete'),
      icon: 'delete',
      action: () => {
        void this.deleteSelected();
      },
      className: 'text-error',
    });

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    menu.innerHTML = items
      .map(
        (item) => `
      <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant cursor-pointer ${item.className || ''}">
        <span class="material-symbols-outlined" style="font-size: 14px;">${item.icon}</span>
        ${item.label}
      </div>
    `
      )
      .join('');

    // Bind actions
    const menuItems = menu.querySelectorAll('div');
    menuItems.forEach((el, idx) => {
      el.addEventListener('click', () => {
        items[idx].action();
        this.hideContextMenu();
      });
    });

    document.body.appendChild(menu);

    // Viewport boundary check: adjust position if menu overflows
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      menu.style.left = Math.max(0, window.innerWidth - menuRect.width - 4) + 'px';
    }
    if (menuRect.bottom > window.innerHeight) {
      menu.style.top = Math.max(0, window.innerHeight - menuRect.height - 4) + 'px';
    }

    // Close on click outside
    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.hideContextMenu();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  private hideContextMenu(): void {
    const menu = document.getElementById('sftp-context-menu');
    if (menu) menu.remove();
  }

  // File upload
  private queueUploadFiles(files: File[]): void {
    const batch = files.slice();
    if (batch.length === 0) return;

    const targetPath = this.currentPath;
    for (const file of batch) {
      void this.enqueueUploadTask(file, targetPath);
    }
  }

  /**
   * 入队一个上传任务（编辑器保存也走此通道，与普通上传串行复用单一上传状态机）。
   * 返回是否真正完成上传（面板隐藏/队列重置时静默跳过返回 false）。
   * reportError=false 表示由调用方自行报告错误（编辑器保存路径用 notify 呈现）。
   */
  private enqueueUploadTask(
    file: File,
    targetPath: string,
    options: { overwriteFirst?: boolean; reportError?: boolean } = {}
  ): Promise<boolean> {
    const generation = this.uploadQueueGeneration;
    const queuedBehindExistingWork = this.uploadQueuePending > 0;
    this.uploadQueuePending++;

    if (queuedBehindExistingWork) {
      this.uploadQueuedFiles++;
      this.setQueueStatus();
    }

    const run = this.uploadQueueTail.then(async () => {
      if (queuedBehindExistingWork) {
        this.uploadQueuedFiles = Math.max(0, this.uploadQueuedFiles - 1);
        this.setQueueStatus();
      }
      if (generation !== this.uploadQueueGeneration || !this.visible) return false;
      return this.uploadSingleFile(file, targetPath, options.overwriteFirst === true);
    });

    const tail: Promise<void> = run.then(
      () => undefined,
      (e) => {
        if (options.reportError !== false) {
          this.showError(
            t('sftp.uploadFailed', { message: e instanceof Error ? e.message : String(e) })
          );
        }
      }
    );

    this.uploadQueueTail = tail.finally(() => {
      if (generation === this.uploadQueueGeneration) {
        this.uploadQueuePending = Math.max(0, this.uploadQueuePending - 1);
      }
    });

    void this.uploadQueueTail;
    return run;
  }

  private resetUploadQueue(): void {
    const cancelActiveUpload = this.uploadActive;
    this.uploadQueueGeneration++;
    this.uploadQueuePending = 0;
    this.uploadQueuedFiles = 0;
    this.uploadActive = false;
    this.uploadCancelRequested = cancelActiveUpload;
    this.uploadCancelConfirmed = true;
    this.uploadWaiter.reject(t('sftp.uploadCancelled'));
    this.resolveUploadCancelWaiter();
    this.uploadQueueTail = Promise.resolve();
  }

  private async uploadSingleFile(
    file: File,
    targetPath: string,
    overwriteFirst: boolean = false
  ): Promise<boolean> {
    const path = targetPath === '/' ? `/${file.name}` : `${targetPath}/${file.name}`;

    let sendOffset = 0;
    let acknowledged = 0;
    const maxBufferedBytes = UPLOAD_CHUNK_SIZE * UPLOAD_CONCURRENCY;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let pendingChunk: Uint8Array | null = null;
    let pendingChunkOffset = 0;

    this.uploadActive = true;
    this.uploadCancelRequested = false;
    this.uploadCancelConfirmed = false;
    this.uploadCancelWaiter = null;
    this.setQueueStatus();

    try {
      const readyPromise = this.uploadWaiter.waitReady();
      this.sendJSON({ type: 'sftp_upload_start', path, size: file.size, overwrite: overwriteFirst });
      let startResult = await readyPromise;

      if (startResult.status === 'conflict') {
        const confirmed = await confirmAction({
          title: t('sftp.overwriteTitle'),
          message: t('sftp.overwriteMessage', {
            name: file.name,
            existingSize: this.formatSize(startResult.conflict.existingSize),
            newSize: this.formatSize(file.size),
          }),
          confirmText: t('sftp.overwrite'),
          cancelText: t('common.cancel'),
          variant: 'danger',
        });
        if (!confirmed || this.uploadCancelRequested || !this.visible) {
          this.uploadActive = false;
          this.setIdleStatus(t('sftp.uploadSkipped'));
          return false;
        }

        const overwriteReadyPromise = this.uploadWaiter.waitReady();
        this.sendJSON({ type: 'sftp_upload_start', path, size: file.size, overwrite: true });
        startResult = await overwriteReadyPromise;
      }

      if (startResult.status !== 'ready') {
        throw new Error(t('sftp.uploadConflictUnresolved'));
      }

      reader = file.stream().getReader();
      this.showProgress(t('sftp.uploading', { name: file.name }), 0);
      if (this.uploadCancelRequested) {
        await this.waitForUploadCancel();
        return false;
      }

      const readNextChunk = async (): Promise<Uint8Array | null> => {
        while (!pendingChunk || pendingChunkOffset >= pendingChunk.length) {
          const { done, value } = await reader!.read();
          if (done) return null;
          pendingChunk = value;
          pendingChunkOffset = 0;
        }

        const end = Math.min(pendingChunkOffset + UPLOAD_CHUNK_SIZE, pendingChunk.length);
        const chunk = pendingChunk.subarray(pendingChunkOffset, end);
        pendingChunkOffset = end;
        return chunk;
      };

      const sendNextChunk = async (): Promise<boolean> => {
        if (this.uploadCancelRequested) {
          throw new Error(t('sftp.uploadCancelled'));
        }
        const value = await readNextChunk();
        if (!value) return false;
        this.sendBinary(value);
        sendOffset += value.length;
        return true;
      };

      while (sendOffset < file.size && sendOffset - acknowledged < maxBufferedBytes) {
        if (this.uploadCancelRequested) {
          await this.waitForUploadCancel();
          return false;
        }
        if (!(await sendNextChunk())) {
          throw new Error(t('sftp.uploadStreamEnded'));
        }
      }

      while (acknowledged < file.size) {
        acknowledged = await this.uploadWaiter.waitProgress();
        if (this.uploadCancelRequested) {
          await this.waitForUploadCancel();
          return false;
        }
        while (sendOffset < file.size && sendOffset - acknowledged < maxBufferedBytes) {
          if (!(await sendNextChunk())) {
            throw new Error(t('sftp.uploadStreamEnded'));
          }
        }
      }

      const completePromise = this.uploadWaiter.waitComplete();
      this.sendJSON({ type: 'sftp_upload_end' });
      await completePromise;
      return true;
    } catch (e) {
      if (this.uploadCancelRequested) {
        await this.waitForUploadCancel();
        this.uploadWaiter.reset();
        return false;
      }
      // 错误上报交由调用方（队列默认 showError / 编辑器保存路径 notify）
      this.sendJSON({ type: 'sftp_upload_cancel' });
      this.uploadWaiter.reset();
      throw e;
    } finally {
      this.uploadActive = false;
      this.uploadCancelRequested = false;
      this.uploadCancelConfirmed = false;
      this.uploadCancelWaiter = null;
      reader?.releaseLock();
    }
  }

  // File download
  private downloadSelected(): void {
    this.downloadEntries([...this.selectedEntries.values()]);
  }

  private downloadEntries(entries: SFTPFileEntry[]): void {
    entries
      .filter((entry) => !entry.isDir)
      .forEach((entry) => {
        const path =
          this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
        this.queueDownloadFile(path, entry.name);
      });
  }

  private queueDownloadFile(path: string, filename: string): void {
    const generation = this.downloadQueueGeneration;
    const queuedBehindExistingWork = this.downloadQueuePending > 0;
    this.downloadQueuePending++;

    if (queuedBehindExistingWork) {
      this.downloadQueuedFiles++;
      this.setQueueStatus();
    }

    const run = this.downloadQueueTail.then(async () => {
      if (queuedBehindExistingWork) {
        this.downloadQueuedFiles = Math.max(0, this.downloadQueuedFiles - 1);
        this.setQueueStatus();
      }
      if (generation !== this.downloadQueueGeneration || !this.visible) return;
      await this.downloadFile(path, filename);
    });

    this.downloadQueueTail = run
      .catch((e) => {
        this.showError(
          t('sftp.downloadFailed', { message: e instanceof Error ? e.message : String(e) })
        );
      })
      .finally(() => {
        if (generation === this.downloadQueueGeneration) {
          this.downloadQueuePending = Math.max(0, this.downloadQueuePending - 1);
        }
      });

    void this.downloadQueueTail;
  }

  private resetDownloadQueue(): void {
    this.downloadQueueGeneration++;
    this.downloadQueuePending = 0;
    this.downloadQueuedFiles = 0;
    this.downloadActive = false;
    this.downloadCancelRequested = false;
    this.downloadQueueTail = Promise.resolve();
    this.rejectDownloadWaiter(t('sftp.downloadCancelled'));
  }

  private async downloadFile(path: string, filename: string): Promise<void> {
    this.downloadActive = true;
    this.downloadCancelRequested = false;
    this.setQueueStatus();
    this.downloadWaiter = new Deferred<void>();
    this.downloadChunks = [];
    this.downloadFilename = filename;
    this.sendJSON({ type: 'sftp_download', path });
    this.showProgress(t('sftp.downloading', { name: filename }), 0);
    try {
      await this.downloadWaiter.promise;
    } catch {
      // The triggering SFTP error/close handler already updated the UI.
    } finally {
      this.downloadActive = false;
      this.downloadCancelRequested = false;
    }
  }

  private onDownloadStart(filename: string): void {
    this.downloadFilename = filename;
    this.downloadChunks = [];
    this.showProgress(t('sftp.downloading', { name: filename }), 0);
  }

  private onDownloadProgress(loaded: number, total: number): void {
    this.updateProgress(loaded, total);
  }

  private onDownloadDone(filename: string): void {
    if (this.downloadCancelRequested || !this.downloadWaiter) {
      this.downloadChunks = [];
      this.downloadFilename = '';
      this.downloadActive = false;
      this.downloadCancelRequested = false;
      this.hideProgress();
      this.setIdleStatus(t('sftp.downloadCancelled'));
      this.resolveDownloadWaiter();
      return;
    }

    const blob = new Blob(this.downloadChunks, { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);

    this.downloadChunks = [];
    this.downloadFilename = '';
    this.downloadActive = false;
    this.hideProgress();
    this.setIdleStatus(this.getItemsStatus());
    this.resolveDownloadWaiter();
  }

  private onDownloadCancelled(): void {
    this.downloadChunks = [];
    this.downloadFilename = '';
    this.downloadActive = false;
    this.downloadCancelRequested = false;
    this.hideProgress();
    this.setIdleStatus(t('sftp.downloadCancelled'));
    this.resolveDownloadWaiter();
  }

  private resolveDownloadWaiter(): void {
    this.downloadWaiter?.resolve();
    this.downloadWaiter = null;
  }

  private rejectDownloadWaiter(message: string): void {
    this.downloadWaiter?.reject(new Error(message));
    this.downloadWaiter = null;
  }

  // ==================== 在线编辑 ====================

  private editSelected(): void {
    const selected = [...this.selectedEntries.values()];
    if (selected.length !== 1 || selected[0].isDir) return;
    const entry = selected[0];
    const path = this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
    void this.openEditorForFile(path, entry.name, entry.size);
  }

  private openEditorForFile(
    path: string,
    filename: string,
    knownSize: number,
    options: { fallbackToDownload?: boolean } = {}
  ): Promise<void> {
    return this.editorCoordinator.openEditorForFile(path, filename, knownSize, options);
  }

  private closeActiveEditor(): void {
    this.editorCoordinator.closeActiveEditor();
  }

  private resetEditState(): void {
    this.editorCoordinator.resetEditState();
  }

  private cancelCurrentTransfer(): void {
    if (this.uploadActive) {
      this.uploadCancelRequested = true;
      this.uploadCancelConfirmed = false;
      if (!this.uploadCancelWaiter) {
        this.uploadCancelWaiter = new Deferred<void>();
      }
      this.sendJSON({ type: 'sftp_upload_cancel' });
      this.hideProgress();
      this.setIdleStatus(t('sftp.uploadCancelled'));
      return;
    }

    if (this.downloadActive) {
      this.downloadCancelRequested = true;
      this.sendJSON({ type: 'sftp_download_cancel' });
      this.downloadChunks = [];
      this.downloadFilename = '';
      this.hideProgress();
      this.setIdleStatus(t('sftp.downloadCancelled'));
    }
  }

  // Upload callbacks
  private onUploadReady(): void {
    this.uploadWaiter.resolveReady();
  }

  private onUploadProgress(loaded: number, total: number): void {
    this.updateProgress(loaded, total);
    this.uploadWaiter.resolveProgress(loaded);
  }

  private onUploadComplete(_path: string): void {
    this.uploadWaiter.resolveComplete();
    this.uploadActive = false;
    this.uploadCancelRequested = false;
    this.uploadCancelConfirmed = false;
    this.uploadCancelWaiter = null;
    this.hideProgress();
    this.setIdleStatus(this.getItemsStatus());
    this.refresh();
  }

  private onUploadCancelled(): void {
    this.uploadCancelConfirmed = true;
    this.uploadActive = false;
    this.uploadWaiter.reject(t('sftp.uploadCancelled'));
    this.hideProgress();
    this.setIdleStatus(t('sftp.uploadCancelled'));
    this.resolveUploadCancelWaiter();
  }

  private rejectUploadWaiter(message: string): void {
    this.uploadCancelConfirmed = true;
    this.uploadWaiter.reject(message);
    this.resolveUploadCancelWaiter();
  }

  private waitForUploadCancel(): Promise<void> {
    if (this.uploadCancelConfirmed) {
      return Promise.resolve();
    }
    if (!this.uploadCancelWaiter) {
      this.uploadCancelWaiter = new Deferred<void>();
    }
    return this.uploadCancelWaiter.promise;
  }

  private resolveUploadCancelWaiter(): void {
    this.uploadCancelWaiter?.resolve();
    this.uploadCancelWaiter = null;
  }

  // Delete
  private async deleteSelected(): Promise<void> {
    const entries = [...this.selectedEntries.values()];
    if (entries.length === 0) return;

    const confirmed = await confirmDeleteItems(entries.map((e) => e.name));
    if (!confirmed) return;

    this.pendingDeleteCount = entries.length;
    for (const entry of entries) {
      const path =
        this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
      this.sendJSON({ type: entry.isDir ? 'sftp_rmdir' : 'sftp_delete', path });
    }
  }

  private onDeleteResult(_path: string): void {
    this.pendingDeleteCount = Math.max(0, this.pendingDeleteCount - 1);
    if (this.pendingDeleteCount === 0) {
      this.setStatus(t('sftp.deleted'));
      this.clearSelection();
      this.refresh();
    }
  }

  // Rename
  private async showRenameDialog(): Promise<void> {
    const selected = [...this.selectedEntries.values()];
    if (selected.length !== 1) return;
    const entry = selected[0];

    const newName = await promptRename(entry.name);
    if (!newName || newName === entry.name) return;

    const oldPath =
      this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
    const newPath = this.currentPath === '/' ? `/${newName}` : `${this.currentPath}/${newName}`;

    this.sendJSON({ type: 'sftp_rename', oldPath, newPath });
  }

  private onRenameResult(): void {
    this.setStatus(t('sftp.renamed'));
    this.clearSelection();
    this.refresh();
  }

  // Sorting
  private toggleSort(field: SFTPSortField): void {
    if (this.sortOptions.field === field) {
      this.sortOptions.direction = this.sortOptions.direction === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortOptions.field = field;
      this.sortOptions.direction = field === 'name' ? 'asc' : 'desc';
    }
    this.updateSortHeaderUI();
    this.renderEntries();
  }

  private updateSortHeaderUI(): void {
    const fields: SFTPSortField[] = ['name', 'size', 'mtime'];
    for (const f of fields) {
      const btn = this.container.querySelector(`#sftp-sort-${f}`);
      if (!btn) continue;
      const icon = btn.querySelector('.sftp-sort-icon') as HTMLElement | null;
      if (!icon) continue;

      if (this.sortOptions.field === f) {
        icon.classList.remove('hidden');
        icon.textContent = this.sortOptions.direction === 'asc' ? 'arrow_upward' : 'arrow_downward';
        btn.classList.add('text-primary-container');
        btn.classList.remove('text-on-surface-variant');
      } else {
        icon.classList.add('hidden');
        btn.classList.remove('text-primary-container');
        btn.classList.add('text-on-surface-variant');
      }
    }
  }

  // Breadcrumbs
  private renderBreadcrumbs(path: string): void {
    const breadcrumbsEl = this.container.querySelector('#sftp-breadcrumbs');
    if (!breadcrumbsEl) return;

    const crumbs = parsePathBreadcrumbs(path);
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    breadcrumbsEl.innerHTML = crumbs
      .map((crumb, idx) => {
        const isLast = idx === crumbs.length - 1;
        const isRoot = idx === 0;
        return `
          <button type="button" class="sftp-crumb-item flex items-center px-1 py-0.5 rounded hover:bg-surface-variant text-[12px] cursor-pointer transition-colors ${isLast ? 'text-primary-container font-semibold' : 'text-on-surface-variant'}" data-path="${this.escapeHtml(crumb.path)}" title="${this.escapeHtml(crumb.path)}">
            ${isRoot ? '<span class="material-symbols-outlined" style="font-size: 15px; font-variation-settings: \'FILL\' 1;">storage</span>' : this.escapeHtml(crumb.name)}
          </button>
          ${isLast ? '' : '<span class="text-on-surface-variant/40 text-[10px] select-none mx-0.5">/</span>'}
        `;
      })
      .join('');

    breadcrumbsEl.querySelectorAll('.sftp-crumb-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetPath = (el as HTMLElement).dataset.path;
        if (targetPath && targetPath !== this.currentPath) {
          this.navigate(targetPath);
        }
      });
    });
  }

  private showPathInput(): void {
    const breadcrumbsEl = this.container.querySelector('#sftp-breadcrumbs');
    const pathInput = this.container.querySelector('#sftp-path-input') as HTMLInputElement | null;
    if (!breadcrumbsEl || !pathInput) return;
    breadcrumbsEl.classList.add('hidden');
    pathInput.classList.remove('hidden');
    pathInput.value = this.currentPath;
    pathInput.focus();
    pathInput.select();
  }

  private showBreadcrumbs(): void {
    const breadcrumbsEl = this.container.querySelector('#sftp-breadcrumbs');
    const pathInput = this.container.querySelector('#sftp-path-input') as HTMLInputElement | null;
    if (!breadcrumbsEl || !pathInput) return;
    pathInput.classList.add('hidden');
    breadcrumbsEl.classList.remove('hidden');
  }

  // New File
  private async showNewFileDialog(): Promise<void> {
    const name = await promptNewFileName();
    if (!name) return;

    const path = this.currentPath === '/' ? `/${name}` : `${this.currentPath}/${name}`;
    const emptyFile = new File([new Uint8Array(0)], name, { type: 'text/plain' });

    try {
      const ok = await this.enqueueUploadTask(emptyFile, this.currentPath, {
        overwriteFirst: false,
        reportError: true,
      });
      if (!ok) return;

      this.refresh();
      await this.openEditorForFile(path, name, 0);
    } catch (e) {
      notify(t('sftp.newFileFailed', { message: e instanceof Error ? e.message : String(e) }), {
        variant: 'danger',
      });
    }
  }

  // Mkdir
  private async showMkdirDialog(): Promise<void> {
    const name = await promptMkdirName();
    if (!name) return;

    const path = this.currentPath === '/' ? `/${name}` : `${this.currentPath}/${name}`;
    this.sendJSON({ type: 'sftp_mkdir', path });
  }

  private onMkdirResult(_path: string): void {
    this.refresh();
  }

  // UI helpers
  private showLoading(): void {
    this.container.querySelector('#sftp-loading')!.classList.remove('hidden');
    this.container.querySelector('#sftp-loading')!.classList.add('flex');
    this.container.querySelector('#sftp-empty')!.classList.add('hidden');
    this.container.querySelector('#sftp-error')!.classList.add('hidden');
    this.container.querySelector('#sftp-entries')!.innerHTML = '';
  }

  private hideLoading(): void {
    this.container.querySelector('#sftp-loading')!.classList.add('hidden');
    this.container.querySelector('#sftp-loading')!.classList.remove('flex');
  }

  private showError(message: string): void {
    const errorEl = this.container.querySelector('#sftp-error')!;
    const errorText = this.container.querySelector('#sftp-error-text')!;
    errorText.textContent = message;
    errorEl.classList.remove('hidden');
    errorEl.classList.add('flex');
    this.hideLoading();
    this.setStatus(t('sftp.statusError'));
  }

  private hideError(): void {
    this.container.querySelector('#sftp-error')!.classList.add('hidden');
    this.container.querySelector('#sftp-error')!.classList.remove('flex');
  }

  private showProgress(text: string, percent: number): void {
    const container = this.container.querySelector('#sftp-progress-container')!;
    const progressText = this.container.querySelector('#sftp-progress-text')!;
    const progressPercent = this.container.querySelector('#sftp-progress-percent')!;
    const progressBar = this.container.querySelector('#sftp-progress-bar')! as HTMLElement;

    container.classList.remove('hidden');
    progressText.textContent = text;
    progressPercent.textContent = Math.round(percent) + '%';
    progressBar.style.width = percent + '%';
  }

  private updateProgress(loaded: number, total: number): void {
    const percent = total > 0 ? (loaded / total) * 100 : 0;
    const progressPercent = this.container.querySelector('#sftp-progress-percent')!;
    const progressBar = this.container.querySelector('#sftp-progress-bar')! as HTMLElement;
    const progressText = this.container.querySelector('#sftp-progress-text')!;

    progressPercent.textContent = Math.round(percent) + '%';
    progressBar.style.width = percent + '%';

    const loadedStr = this.formatSize(loaded);
    const totalStr = this.formatSize(total);
    progressText.textContent =
      progressText.textContent?.replace(/\(.*/, '') + ` (${loadedStr} / ${totalStr})`;
  }

  private hideProgress(): void {
    this.container.querySelector('#sftp-progress-container')!.classList.add('hidden');
  }

  private setIdleStatus(fallback: string): void {
    if (this.setQueueStatus()) return;
    this.setStatus(fallback);
  }

  private setQueueStatus(): boolean {
    if (this.uploadQueuedFiles > 0) {
      this.setStatus(t('sftp.queuedUpload', { count: this.uploadQueuedFiles }));
      return true;
    }

    if (this.downloadQueuedFiles > 0) {
      this.setStatus(t('sftp.queuedDownload', { count: this.downloadQueuedFiles }));
      return true;
    }

    if (this.uploadActive) {
      this.setStatus(t('sftp.uploadingFiles'));
      return true;
    }

    if (this.downloadActive) {
      this.setStatus(t('sftp.downloadingFiles'));
      return true;
    }

    return false;
  }

  private setStatus(text: string): void {
    (this.container.querySelector('#sftp-status-text') as HTMLElement).textContent = text;
  }

  private updateItemCount(_count: number): void {
    const dirs = this.entries.filter((e) => e.isDir).length;
    const files = this.entries.filter((e) => !e.isDir).length;
    (this.container.querySelector('#sftp-item-count') as HTMLElement).textContent = t(
      'sftp.itemCounts',
      { dirs, files }
    );
  }

  private getItemsStatus(): string {
    return t('sftp.items', { count: this.entries.length });
  }

  private getFileIcon(filename: string): string {
    return getFileIcon(filename);
  }

  private formatSize(bytes: number): string {
    return formatSize(bytes);
  }

  private formatTimestamp(unixTime: number): string {
    return formatTimestamp(unixTime);
  }

  private escapeHtml(str: string): string {
    return escapeHtml(str);
  }

  dispose(): void {
    this.localeCleanup?.();
    this.localeCleanup = null;
    this.resetUploadQueue();
    this.resetDownloadQueue();
    this.editorCoordinator.dispose();
    this.closeWebSocket(1000, 'SFTP panel disposed');
    document.removeEventListener('keydown', this.keydownHandler);
    this.container.remove();
  }
}
