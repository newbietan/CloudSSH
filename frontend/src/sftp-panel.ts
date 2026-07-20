import { confirmAction, requestText } from './ui-feedback';

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

function validateRemoteName(value: string): string | null {
  if (value === '.' || value === '..') return '名称不能是“.”或“..”';
  if (value.includes('/') || value.includes('\0')) return '名称不能包含“/”或空字符';
  return null;
}

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class UploadWaiter {
  private ready: Deferred<void> | null = null;
  private progress: Deferred<number> | null = null;
  private complete: Deferred<void> | null = null;
  private progressQueue: number[] = [];
  private progressQueueHead = 0;

  waitReady(): Promise<void> {
    this.ready = new Deferred<void>();
    return this.ready.promise;
  }

  resolveReady(): void {
    this.ready?.resolve();
    this.ready = null;
  }

  waitProgress(): Promise<number> {
    const queued = this.progressQueue[this.progressQueueHead];
    if (queued !== undefined) {
      this.progressQueueHead++;
      this.compactProgressQueue();
      return Promise.resolve(queued);
    }

    this.progress = new Deferred<number>();
    return this.progress.promise;
  }

  resolveProgress(loaded: number): void {
    if (this.progress) {
      this.progress.resolve(loaded);
      this.progress = null;
      return;
    }

    this.progressQueue.push(loaded);
  }

  waitComplete(): Promise<void> {
    this.complete = new Deferred<void>();
    return this.complete.promise;
  }

  resolveComplete(): void {
    this.complete?.resolve();
    this.reset();
  }

  reject(message: string): void {
    const error = new Error(message);
    this.ready?.reject(error);
    this.progress?.reject(error);
    this.complete?.reject(error);
    this.reset();
  }

  reset(): void {
    this.ready = null;
    this.progress = null;
    this.complete = null;
    this.progressQueue = [];
    this.progressQueueHead = 0;
  }

  private compactProgressQueue(): void {
    if (this.progressQueueHead > 32 && this.progressQueueHead * 2 > this.progressQueue.length) {
      this.progressQueue = this.progressQueue.slice(this.progressQueueHead);
      this.progressQueueHead = 0;
    }
  }
}

export class SFTPPanel {
  private container: HTMLElement;
  private currentPath: string = '/';
  private entries: SFTPFileEntry[] = [];
  private selectedEntry: SFTPFileEntry | null = null;
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
  private downloadSize: number = 0;
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
  private readonly keydownHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.visible && !document.querySelector('dialog[open]')) {
      this.hide();
    }
  };

  constructor(getWebSocketUrl: GetSFTPWebSocketUrlFn) {
    this.getWebSocketUrl = getWebSocketUrl;
    this.container = this.createPanel();
    document.body.appendChild(this.container);
    this.bindKeyboard();
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'sftp-panel';
    panel.className = 'fixed top-0 right-0 h-full z-[90] flex transition-transform duration-300 ease-in-out';
    panel.style.width = 'min(420px, 100vw)';
    panel.style.transform = 'translateX(100%)';

    panel.innerHTML = `
      <div class="flex flex-col w-full h-full bg-surface border-l border-outline-variant text-on-surface">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 h-12 border-b border-outline-variant bg-elevated shrink-0">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary-container" style="font-size: 18px; font-variation-settings: 'FILL' 1;">folder_open</span>
            <span class="text-xs font-bold tracking-[0.1em] text-primary-container">SFTP_FILE_MANAGER</span>
          </div>
          <button id="sftp-close-btn" class="hover:opacity-80 transition-opacity cursor-pointer p-1 text-on-surface-variant" title="Close">
            <span class="material-symbols-outlined" style="font-size: 18px;">close</span>
          </button>
        </div>

        <!-- Toolbar -->
        <div class="flex items-center gap-2 px-3 py-2 border-b border-outline-variant bg-surface shrink-0">
          <button id="sftp-back-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer" title="Back">
            <span class="material-symbols-outlined" style="font-size: 18px;">arrow_back</span>
          </button>
          <button id="sftp-home-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer" title="Home">
            <span class="material-symbols-outlined" style="font-size: 18px;">home</span>
          </button>
          <button id="sftp-refresh-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer" title="Refresh">
            <span class="material-symbols-outlined" style="font-size: 18px;">refresh</span>
          </button>
          <input id="sftp-path-input" class="flex-1 terminal-input text-[12px] px-2 py-1" type="text" value="/" />
          <button id="sftp-go-btn" class="p-1 hover:bg-surface-variant rounded transition-colors cursor-pointer text-primary-container" title="Go">
            <span class="material-symbols-outlined" style="font-size: 18px;">arrow_forward</span>
          </button>
        </div>

        <!-- Actions Bar -->
        <div class="flex items-center gap-1 px-3 py-1.5 border-b border-outline-variant bg-surface shrink-0">
          <button id="sftp-upload-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-primary-container" title="Upload File">
            <span class="material-symbols-outlined" style="font-size: 14px;">upload_file</span>
            UPLOAD
          </button>
          <button id="sftp-mkdir-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-secondary-container" title="New Folder">
            <span class="material-symbols-outlined" style="font-size: 14px;">create_new_folder</span>
            MKDIR
          </button>
          <button id="sftp-download-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-on-surface-variant disabled:opacity-30" title="Download" disabled>
            <span class="material-symbols-outlined" style="font-size: 14px;">download</span>
            DOWNLOAD
          </button>
          <button id="sftp-delete-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-error-container rounded transition-colors cursor-pointer text-error disabled:opacity-30" title="Delete" disabled>
            <span class="material-symbols-outlined" style="font-size: 14px;">delete</span>
            DELETE
          </button>
          <button id="sftp-rename-btn" class="flex items-center gap-1 px-2 py-1 text-[11px] font-bold tracking-wider hover:bg-surface-variant rounded transition-colors cursor-pointer text-on-surface-variant disabled:opacity-30" title="Rename" disabled>
            <span class="material-symbols-outlined" style="font-size: 14px;">drive_file_rename_outline</span>
            RENAME
          </button>
          <input type="file" id="sftp-file-input" class="hidden" multiple />
        </div>

        <!-- Progress Bar -->
        <div id="sftp-progress-container" class="hidden px-3 py-1.5 border-b border-outline-variant bg-surface shrink-0">
          <div class="flex items-center justify-between text-[11px] mb-1">
            <span id="sftp-progress-text" class="text-on-surface-variant truncate"></span>
            <div class="flex items-center gap-2 shrink-0">
              <span id="sftp-progress-percent" class="text-primary-container font-bold"></span>
              <button id="sftp-transfer-cancel-btn" class="text-error hover:opacity-80 cursor-pointer flex items-center justify-center" title="Cancel transfer">
                <span class="material-symbols-outlined" style="font-size: 14px;">close</span>
              </button>
            </div>
          </div>
          <div class="w-full h-1.5 bg-surface-variant rounded-full overflow-hidden">
            <div id="sftp-progress-bar" class="h-full bg-primary-container rounded-full transition-all duration-200" style="width: 0%"></div>
          </div>
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
            <span class="text-xs tracking-wider">EMPTY_DIRECTORY</span>
          </div>
          <!-- Error state -->
          <div id="sftp-error" class="hidden flex flex-col items-center justify-center py-8 px-4 text-error">
            <span class="material-symbols-outlined mb-2" style="font-size: 28px;">error</span>
            <span id="sftp-error-text" class="text-xs text-center"></span>
          </div>
          <!-- Truncated warning -->
          <div id="sftp-truncated-warning" class="hidden flex items-center justify-center py-2 px-3 bg-tertiary-container text-on-tertiary-container text-xs mb-2 rounded mx-2 mt-2">
            <span class="material-symbols-outlined mr-2" style="font-size: 16px;">warning</span>
            该目录文件过多，为保证性能，仅显示前 2000 项。
          </div>
          <!-- Entries will be rendered here -->
          <div id="sftp-entries"></div>
        </div>

        <!-- Status Bar -->
        <div class="flex items-center justify-between px-3 py-1.5 border-t border-outline-variant bg-elevated text-[10px] text-on-surface-variant shrink-0">
          <span id="sftp-status-text">Ready</span>
          <span id="sftp-item-count"></span>
        </div>
      </div>
    `;

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
    const mkdirBtn = this.container.querySelector('#sftp-mkdir-btn')!;
    const downloadBtn = this.container.querySelector('#sftp-download-btn')!;
    const deleteBtn = this.container.querySelector('#sftp-delete-btn')!;
    const renameBtn = this.container.querySelector('#sftp-rename-btn')!;
    const cancelTransferBtn = this.container.querySelector('#sftp-transfer-cancel-btn')!;
    const fileInput = this.container.querySelector('#sftp-file-input') as HTMLInputElement;
    const pathInput = this.container.querySelector('#sftp-path-input') as HTMLInputElement;

    closeBtn.addEventListener('click', () => this.hide());
    backBtn.addEventListener('click', () => this.goBack());
    homeBtn.addEventListener('click', () => this.navigate('~'));
    refreshBtn.addEventListener('click', () => this.refresh());
    goBtn.addEventListener('click', () => this.navigate(pathInput.value));
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.navigate(pathInput.value);
    });

    uploadBtn.addEventListener('click', () => fileInput.click());
    mkdirBtn.addEventListener('click', () => this.showMkdirDialog());
    downloadBtn.addEventListener('click', () => this.downloadSelected());
    deleteBtn.addEventListener('click', () => this.deleteSelected());
    renameBtn.addEventListener('click', () => this.showRenameDialog());
    cancelTransferBtn.addEventListener('click', () => this.cancelCurrentTransfer());

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
    this.resetUploadQueue();
    this.resetDownloadQueue();
    this.uploadWaiter.reset();
    this.sftpReady = false;
    this.downloadChunks = [];
    this.downloadFilename = '';
    this.downloadSize = 0;
    this.hideProgress();
    this.hideError();

    if (!this.visible) {
      this.initializing = false;
      return;
    }

    this.initializing = true;
    this.showLoading();
    this.setStatus('Reconnecting SFTP...');
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
      this.setStatus('Waiting for SFTP WebSocket...');
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
            this.showError('Invalid SFTP response');
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryData(new Uint8Array(event.data));
        }
      };

      ws.onerror = () => {
        this.stopHeartbeat();
        this.connectingPromise = null;
        this.initializing = false;
        this.sftpReady = false;
        this.pendingSends = [];
        this.rejectUploadWaiter('SFTP WebSocket error');
        this.rejectDownloadWaiter('SFTP WebSocket error');
        this.showError('SFTP WebSocket error');
        reject(new Error('SFTP WebSocket error'));
      };

      ws.onclose = () => {
        this.stopHeartbeat();
        if (this.ws === ws) {
          this.ws = null;
        }
        this.connectingPromise = null;

        if (!this.closedByPanel.has(ws)) {
          this.initializing = false;
          this.sftpReady = false;
          this.pendingSends = [];
          this.rejectUploadWaiter('SFTP connection closed');
          this.rejectDownloadWaiter('SFTP connection closed');
          if (this.visible) this.showError('SFTP connection closed');
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
      try { ws.close(code, reason); } catch {}
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
        break;
      case 'pong':
        break;
      case 'sftp_download_start':
        this.onDownloadStart(msg.filename, msg.size);
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
        this.onMkdirResult(msg.path);
        break;
      case 'sftp_closed':
        this.initializing = false;
        this.sftpReady = false;
        this.rejectUploadWaiter('SFTP connection closed');
        this.rejectDownloadWaiter('SFTP connection closed');
        if (this.visible) {
          this.showError('SFTP connection closed');
        }
        break;
      case 'sftp_error':
        this.handleSFTPError(msg);
        break;
    }
  }

  private handleSFTPError(msg: any): void {
    const operation = typeof msg.operation === 'string' ? msg.operation : '';

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

    this.showError(msg.message);

    if (operation === 'upload' || operation === 'download' || operation === 'init') {
      this.hideProgress();
    }
  }

  // Handle binary data (download chunks)
  handleBinaryData(data: Uint8Array): void {
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
    pathInput.value = path;

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

    // Sort: directories first, then by name
    const sorted = [...this.entries].sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });

    entriesContainer.innerHTML = sorted.map((entry, idx) => `
      <div class="sftp-entry flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant cursor-pointer transition-colors border-b border-outline-variant/30 text-[12px]"
           data-idx="${idx}" data-name="${this.escapeHtml(entry.name)}" data-type="${entry.type}">
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
    `).join('');

    // Bind click events
    entriesContainer.querySelectorAll('.sftp-entry').forEach(el => {
      el.addEventListener('click', (e) => {
        const target = el as HTMLElement;
        const idx = parseInt(target.dataset['idx']!);
        const entry = sorted[idx];
        this.selectEntry(entry, target);
      });

      el.addEventListener('dblclick', (e) => {
        const target = el as HTMLElement;
        const idx = parseInt(target.dataset['idx']!);
        const entry = sorted[idx];
        if (entry.isDir) {
          this.navigate(this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`);
        } else {
          // Download on double-click
          this.selectedEntry = entry;
          this.downloadSelected();
        }
      });

      // Right-click context menu
      el.addEventListener('contextmenu', (e: Event) => {
        const me = e as MouseEvent;
        me.preventDefault();
        const target = el as HTMLElement;
        const idx = parseInt(target.dataset['idx']!);
        const entry = sorted[idx];
        this.selectEntry(entry, target);
        this.showContextMenu(me.clientX, me.clientY, entry);
      });
    });
  }

  private selectEntry(entry: SFTPFileEntry, el: HTMLElement): void {
    // Remove previous selection
    this.container.querySelectorAll('.sftp-entry').forEach(e => e.classList.remove('bg-surface-variant'));
    el.classList.add('bg-surface-variant');
    this.selectedEntry = entry;
    this.updateActionButtons();
  }

  private clearSelection(): void {
    this.container.querySelectorAll('.sftp-entry').forEach(e => e.classList.remove('bg-surface-variant'));
    this.selectedEntry = null;
    this.updateActionButtons();
  }

  private updateActionButtons(): void {
    const downloadBtn = this.container.querySelector('#sftp-download-btn') as HTMLButtonElement;
    const deleteBtn = this.container.querySelector('#sftp-delete-btn') as HTMLButtonElement;
    const renameBtn = this.container.querySelector('#sftp-rename-btn') as HTMLButtonElement;

    const hasSelection = !!this.selectedEntry;
    downloadBtn.disabled = !hasSelection || this.selectedEntry!.isDir;
    deleteBtn.disabled = !hasSelection;
    renameBtn.disabled = !hasSelection;
  }

  private showContextMenu(x: number, y: number, entry: SFTPFileEntry): void {
    this.hideContextMenu();

    const menu = document.createElement('div');
    menu.id = 'sftp-context-menu';
    menu.className = 'fixed z-[200] bg-elevated border border-outline-variant shadow-lg py-1 text-[12px]';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const items = [
      { label: 'Open', icon: 'open_in_new', action: () => {
        if (entry.isDir) {
          this.navigate(this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`);
        } else {
          this.selectedEntry = entry;
          this.downloadSelected();
        }
      }},
      ...(entry.type === 'file' ? [{ label: 'Download', icon: 'download', action: () => { this.selectedEntry = entry; this.downloadSelected(); } }] : []),
      { label: 'Rename', icon: 'drive_file_rename_outline', action: () => { this.selectedEntry = entry; this.showRenameDialog(); } },
      { label: 'Delete', icon: 'delete', action: () => { this.selectedEntry = entry; this.deleteSelected(); }, className: 'text-error' },
    ];

    menu.innerHTML = items.map(item => `
      <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant cursor-pointer ${item.className || ''}">
        <span class="material-symbols-outlined" style="font-size: 14px;">${item.icon}</span>
        ${item.label}
      </div>
    `).join('');

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
    const generation = this.uploadQueueGeneration;
    let queuedFilesAdded = 0;

    for (const file of batch) {
      const queuedBehindExistingWork = this.uploadQueuePending > 0;
      this.uploadQueuePending++;

      if (queuedBehindExistingWork) {
        this.uploadQueuedFiles++;
        queuedFilesAdded++;
      }

      const run = this.uploadQueueTail.then(async () => {
        if (queuedBehindExistingWork) {
          this.uploadQueuedFiles = Math.max(0, this.uploadQueuedFiles - 1);
          this.setQueueStatus();
        }
        if (generation !== this.uploadQueueGeneration || !this.visible) return;
        await this.uploadSingleFile(file, targetPath);
      });

      this.uploadQueueTail = run
        .catch((e) => {
          this.showError('Upload failed: ' + (e instanceof Error ? e.message : String(e)));
        })
        .finally(() => {
          if (generation === this.uploadQueueGeneration) {
            this.uploadQueuePending = Math.max(0, this.uploadQueuePending - 1);
          }
        });
    }

    if (queuedFilesAdded > 0) {
      this.setQueueStatus();
    }

    void this.uploadQueueTail;
  }

  private resetUploadQueue(): void {
    const cancelActiveUpload = this.uploadActive;
    this.uploadQueueGeneration++;
    this.uploadQueuePending = 0;
    this.uploadQueuedFiles = 0;
    this.uploadActive = false;
    this.uploadCancelRequested = cancelActiveUpload;
    this.uploadCancelConfirmed = true;
    this.uploadWaiter.reject('Upload cancelled');
    this.resolveUploadCancelWaiter();
    this.uploadQueueTail = Promise.resolve();
  }

  private async uploadSingleFile(file: File, targetPath: string): Promise<void> {
    const path = targetPath === '/' ? `/${file.name}` : `${targetPath}/${file.name}`;

    let sendOffset = 0;
    let acknowledged = 0;
    const maxBufferedBytes = UPLOAD_CHUNK_SIZE * UPLOAD_CONCURRENCY;
    const reader = file.stream().getReader();
    let pendingChunk: Uint8Array | null = null;
    let pendingChunkOffset = 0;

    this.uploadActive = true;
    this.uploadCancelRequested = false;
    this.uploadCancelConfirmed = false;
    this.uploadCancelWaiter = null;
    this.setQueueStatus();

    try {
      const readyPromise = this.uploadWaiter.waitReady();
      this.sendJSON({ type: 'sftp_upload_start', path, size: file.size });
      this.showProgress('Uploading: ' + file.name, 0);
      await readyPromise;
      if (this.uploadCancelRequested) {
        await this.waitForUploadCancel();
        return;
      }

      const readNextChunk = async (): Promise<Uint8Array | null> => {
        while (!pendingChunk || pendingChunkOffset >= pendingChunk.length) {
          const { done, value } = await reader.read();
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
          throw new Error('Upload cancelled');
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
          return;
        }
        if (!await sendNextChunk()) {
          throw new Error('File stream ended before upload completed');
        }
      }

      while (acknowledged < file.size) {
        acknowledged = await this.uploadWaiter.waitProgress();
        if (this.uploadCancelRequested) {
          await this.waitForUploadCancel();
          return;
        }
        while (sendOffset < file.size && sendOffset - acknowledged < maxBufferedBytes) {
          if (!await sendNextChunk()) {
            throw new Error('File stream ended before upload completed');
          }
        }
      }

      const completePromise = this.uploadWaiter.waitComplete();
      this.sendJSON({ type: 'sftp_upload_end' });
      await completePromise;
    } catch (e) {
      if (this.uploadCancelRequested) {
        await this.waitForUploadCancel();
      } else {
        this.sendJSON({ type: 'sftp_upload_cancel' });
        this.showError('Upload failed: ' + (e instanceof Error ? e.message : String(e)));
      }
      this.uploadWaiter.reset();
      return;
    } finally {
      this.uploadActive = false;
      this.uploadCancelRequested = false;
      this.uploadCancelConfirmed = false;
      this.uploadCancelWaiter = null;
      reader.releaseLock();
    }
  }

  // File download
  private downloadSelected(): void {
    if (!this.selectedEntry || this.selectedEntry.isDir) return;

    const path = this.currentPath === '/' ? `/${this.selectedEntry.name}` : `${this.currentPath}/${this.selectedEntry.name}`;
    this.queueDownloadFile(path, this.selectedEntry.name);
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
        this.showError('Download failed: ' + (e instanceof Error ? e.message : String(e)));
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
    this.rejectDownloadWaiter('Download cancelled');
  }

  private async downloadFile(path: string, filename: string): Promise<void> {
    this.downloadActive = true;
    this.downloadCancelRequested = false;
    this.setQueueStatus();
    this.downloadWaiter = new Deferred<void>();
    this.downloadChunks = [];
    this.downloadFilename = filename;
    this.downloadSize = 0;
    this.sendJSON({ type: 'sftp_download', path });
    this.showProgress('Downloading: ' + filename, 0);
    try {
      await this.downloadWaiter.promise;
    } catch {
      // The triggering SFTP error/close handler already updated the UI.
    } finally {
      this.downloadActive = false;
      this.downloadCancelRequested = false;
    }
  }

  private onDownloadStart(filename: string, size: number): void {
    this.downloadFilename = filename;
    this.downloadSize = size;
    this.downloadChunks = [];
    this.showProgress('Downloading: ' + filename, 0);
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
      this.setIdleStatus('Download cancelled');
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
    this.setIdleStatus('Download cancelled');
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

  private cancelCurrentTransfer(): void {
    if (this.uploadActive) {
      this.uploadCancelRequested = true;
      this.uploadCancelConfirmed = false;
      if (!this.uploadCancelWaiter) {
        this.uploadCancelWaiter = new Deferred<void>();
      }
      this.sendJSON({ type: 'sftp_upload_cancel' });
      this.hideProgress();
      this.setIdleStatus('Upload cancelled');
      return;
    }

    if (this.downloadActive) {
      this.downloadCancelRequested = true;
      this.sendJSON({ type: 'sftp_download_cancel' });
      this.downloadChunks = [];
      this.downloadFilename = '';
      this.hideProgress();
      this.setIdleStatus('Download cancelled');
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

  private onUploadComplete(path: string): void {
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
    this.uploadWaiter.reject('Upload cancelled');
    this.hideProgress();
    this.setIdleStatus('Upload cancelled');
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
    const entry = this.selectedEntry;
    if (!entry) return;

    const path = this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
    const confirmed = await confirmAction({
      title: entry.isDir ? '删除目录' : '删除文件',
      message: entry.isDir
        ? `确定要删除目录“${entry.name}”及其中的全部内容吗？此操作无法撤销。`
        : `确定要删除文件“${entry.name}”吗？此操作无法撤销。`,
      confirmText: '删除',
      cancelText: '取消',
      variant: 'danger',
    });
    if (!confirmed) return;

    if (entry.isDir) {
      this.sendJSON({ type: 'sftp_rmdir', path });
    } else {
      this.sendJSON({ type: 'sftp_delete', path });
    }
  }

  private onDeleteResult(_path: string): void {
    this.setStatus('Deleted');
    this.clearSelection();
    this.refresh();
  }

  // Rename
  private async showRenameDialog(): Promise<void> {
    const entry = this.selectedEntry;
    if (!entry) return;

    const newName = await requestText({
      title: '重命名',
      message: `为“${entry.name}”输入新名称。`,
      label: '新名称',
      defaultValue: entry.name,
      confirmText: '重命名',
      cancelText: '取消',
      maxLength: 255,
      validate: validateRemoteName,
    });
    if (!newName || newName === entry.name) return;

    const oldPath = this.currentPath === '/' ? `/${entry.name}` : `${this.currentPath}/${entry.name}`;
    const newPath = this.currentPath === '/' ? `/${newName}` : `${this.currentPath}/${newName}`;

    this.sendJSON({ type: 'sftp_rename', oldPath, newPath });
  }

  private onRenameResult(): void {
    this.setStatus('Renamed');
    this.clearSelection();
    this.refresh();
  }

  // Mkdir
  private async showMkdirDialog(): Promise<void> {
    const name = await requestText({
      title: '新建目录',
      message: `在“${this.currentPath}”中新建目录。`,
      label: '目录名称',
      placeholder: '请输入目录名称',
      confirmText: '创建',
      cancelText: '取消',
      maxLength: 255,
      validate: validateRemoteName,
    });
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
    this.setStatus('Error');
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
    progressText.textContent = progressText.textContent?.replace(/\(.*/, '') + ` (${loadedStr} / ${totalStr})`;
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
      this.setStatus(`Queued upload: ${this.uploadQueuedFiles} file(s)`);
      return true;
    }

    if (this.downloadQueuedFiles > 0) {
      this.setStatus(`Queued download: ${this.downloadQueuedFiles} file(s)`);
      return true;
    }

    if (this.uploadActive) {
      this.setStatus('Uploading files');
      return true;
    }

    if (this.downloadActive) {
      this.setStatus('Downloading files');
      return true;
    }

    return false;
  }

  private setStatus(text: string): void {
    (this.container.querySelector('#sftp-status-text') as HTMLElement).textContent = text;
  }

  private updateItemCount(count: number): void {
    const dirs = this.entries.filter(e => e.isDir).length;
    const files = this.entries.filter(e => !e.isDir).length;
    (this.container.querySelector('#sftp-item-count') as HTMLElement).textContent =
      `${dirs} dirs, ${files} files`;
  }

  private getItemsStatus(): string {
    return `${this.entries.length} items`;
  }

  private getFileIcon(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'js': case 'ts': case 'jsx': case 'tsx': return 'javascript';
      case 'py': return 'code';
      case 'sh': case 'bash': case 'zsh': return 'terminal';
      case 'json': case 'yaml': case 'yml': case 'toml': return 'data_object';
      case 'md': case 'txt': case 'log': return 'description';
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': return 'image';
      case 'mp4': case 'mkv': case 'avi': case 'mov': return 'movie';
      case 'mp3': case 'wav': case 'ogg': return 'audio_file';
      case 'zip': case 'tar': case 'gz': case 'bz2': case 'xz': case '7z': return 'folder_zip';
      case 'pdf': return 'picture_as_pdf';
      case 'html': case 'htm': return 'html';
      case 'css': case 'scss': case 'less': return 'css';
      case 'go': return 'code';
      case 'rs': return 'code';
      case 'c': case 'h': case 'cpp': case 'hpp': return 'code';
      case 'java': case 'kt': return 'code';
      case 'rb': return 'code';
      case 'php': return 'code';
      case 'sql': return 'database';
      case 'xml': return 'code';
      case 'conf': case 'cfg': case 'ini': case 'env': return 'settings';
      default: return 'draft';
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  private formatTimestamp(unixTime: number): string {
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

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  dispose(): void {
    this.resetUploadQueue();
    this.resetDownloadQueue();
    this.closeWebSocket(1000, 'SFTP panel disposed');
    document.removeEventListener('keydown', this.keydownHandler);
    this.container.remove();
  }
}
