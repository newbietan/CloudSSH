export interface SFTPFileEntry {
  name: string;
  type: 'dir' | 'link' | 'file';
  size: number;
  sizeFormatted: string;
  permissions: string;
  permissionsRaw: number;
  modifiedTime: number;
  modifiedTimeFormatted: string;
  isDir: boolean;
  isLink: boolean;
}

export type SendSFTPMessageFn = (msg: any) => void;
export type SendBinaryFn = (data: ArrayBuffer) => void;

export class SFTPPanel {
  private container: HTMLElement;
  private currentPath: string = '/';
  private entries: SFTPFileEntry[] = [];
  private selectedEntry: SFTPFileEntry | null = null;
  private sendJSON: SendSFTPMessageFn;
  private sendBinary: SendBinaryFn;
  private visible: boolean = false;
  private initializing: boolean = false;
  private downloadChunks: Uint8Array[] = [];
  private downloadFilename: string = '';
  private downloadSize: number = 0;
  private onClosedCallback: (() => void) | null = null;

  constructor(
    sendJSON: SendSFTPMessageFn,
    sendBinary: SendBinaryFn,
  ) {
    this.sendJSON = sendJSON;
    this.sendBinary = sendBinary;
    this.container = this.createPanel();
    document.body.appendChild(this.container);
    this.bindKeyboard();
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.id = 'sftp-panel';
    panel.className = 'fixed top-0 right-0 h-full z-[90] flex transition-transform duration-300 ease-in-out';
    panel.style.width = '420px';
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
            <span id="sftp-progress-percent" class="text-primary-container font-bold"></span>
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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) {
        this.hide();
      }
    });
  }

  setOnClosedCallback(callback: () => void): void {
    this.onClosedCallback = callback;
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

    fileInput.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.uploadFiles(Array.from(files));
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
        this.uploadFiles(Array.from(files));
      }
    });
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.container.style.transform = 'translateX(0)';

    if (!this.initializing) {
      this.initializing = true;
      this.sendJSON({ type: 'sftp_init' });
      this.showLoading();
    }
  }

  hide(): void {
    this.visible = false;
    this.container.style.transform = 'translateX(100%)';
    this.sendJSON({ type: 'sftp_close' });
    this.initializing = false;
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

  // Handle messages from the backend
  handleMessage(msg: any): void {
    switch (msg.type) {
      case 'sftp_ready':
        this.initializing = true;
        this.navigate('~');
        break;
      case 'sftp_list_result':
        this.onListResult(msg.path, msg.entries);
        break;
      case 'sftp_stat_result':
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
        this.hideProgress();
        this.setStatus('Upload cancelled');
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
        if (this.visible) {
          this.showError('SFTP connection closed');
        }
        this.onClosedCallback?.();
        break;
      case 'sftp_error':
        this.showError(msg.message);
        this.hideProgress();
        break;
    }
  }

  // Handle binary data (download chunks)
  handleBinaryData(data: ArrayBuffer): void {
    if (this.downloadFilename) {
      this.downloadChunks.push(new Uint8Array(data));
    }
  }

  // Navigation
  private navigate(path: string): void {
    this.showLoading();
    this.clearSelection();
    this.sendJSON({ type: 'sftp_list', path });
  }

  private refresh(): void {
    this.navigate(this.currentPath);
  }

  private goBack(): void {
    const parts = this.currentPath.split('/').filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    this.navigate('/' + parts.join('/') || '/');
  }

  // Directory listing results
  private onListResult(path: string, entries: SFTPFileEntry[]): void {
    this.currentPath = path;
    this.entries = entries;

    const pathInput = this.container.querySelector('#sftp-path-input') as HTMLInputElement;
    pathInput.value = path;

    this.renderEntries();
    this.hideLoading();
    this.hideError();
    this.setStatus(`${entries.length} items`);
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
        <span class="text-on-surface-variant text-[10px] w-24 text-right shrink-0 hidden lg:block">${entry.modifiedTimeFormatted}</span>
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
  private async uploadFiles(files: File[]): Promise<void> {
    for (const file of files) {
      await this.uploadSingleFile(file);
    }
  }

  private async uploadSingleFile(file: File): Promise<void> {
    const path = this.currentPath === '/' ? `/${file.name}` : `${this.currentPath}/${file.name}`;

    // Send upload start
    this.sendJSON({ type: 'sftp_upload_start', path, size: file.size });
    this.showProgress('Uploading: ' + file.name, 0);

    // Read and send file in chunks
    const CHUNK_SIZE = 32768;
    let offset = 0;

    const reader = file.stream().getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Send binary chunk
        this.sendBinary(value.buffer);
        offset += value.length;

        this.updateProgress(offset, file.size);
      }
    } catch (e) {
      this.sendJSON({ type: 'sftp_upload_cancel' });
      this.showError('Upload failed: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }

    // Send upload end
    this.sendJSON({ type: 'sftp_upload_end' });
  }

  // File download
  private downloadSelected(): void {
    if (!this.selectedEntry || this.selectedEntry.isDir) return;

    const path = this.currentPath === '/' ? `/${this.selectedEntry.name}` : `${this.currentPath}/${this.selectedEntry.name}`;
    this.downloadChunks = [];
    this.downloadFilename = this.selectedEntry.name;
    this.downloadSize = 0;
    this.sendJSON({ type: 'sftp_download', path });
    this.showProgress('Downloading: ' + this.selectedEntry.name, 0);
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
    // Combine chunks and trigger download
    const totalSize = this.downloadChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of this.downloadChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const blob = new Blob([combined]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    this.downloadChunks = [];
    this.downloadFilename = '';
    this.hideProgress();
    this.setStatus('Downloaded: ' + filename);
    this.refresh();
  }

  // Upload callbacks
  private pendingUploads: string[] = [];

  private onUploadReady(): void {
    // Ready to receive chunks - chunks are already being sent
  }

  private onUploadProgress(loaded: number, total: number): void {
    this.updateProgress(loaded, total);
  }

  private onUploadComplete(path: string): void {
    this.hideProgress();
    this.setStatus('Uploaded: ' + path.split('/').pop());
    this.refresh();
  }

  // Delete
  private deleteSelected(): void {
    if (!this.selectedEntry) return;

    const path = this.currentPath === '/' ? `/${this.selectedEntry.name}` : `${this.currentPath}/${this.selectedEntry.name}`;

    if (this.selectedEntry.isDir) {
      if (!confirm(`Delete directory "${this.selectedEntry.name}" and all its contents?`)) return;
      this.sendJSON({ type: 'sftp_rmdir', path });
    } else {
      if (!confirm(`Delete file "${this.selectedEntry.name}"?`)) return;
      this.sendJSON({ type: 'sftp_delete', path });
    }
  }

  private onDeleteResult(_path: string): void {
    this.setStatus('Deleted');
    this.clearSelection();
    this.refresh();
  }

  // Rename
  private showRenameDialog(): void {
    if (!this.selectedEntry) return;

    const newName = prompt('New name:', this.selectedEntry.name);
    if (!newName || newName === this.selectedEntry.name) return;

    const oldPath = this.currentPath === '/' ? `/${this.selectedEntry.name}` : `${this.currentPath}/${this.selectedEntry.name}`;
    const newPath = this.currentPath === '/' ? `/${newName}` : `${this.currentPath}/${newName}`;

    this.sendJSON({ type: 'sftp_rename', oldPath, newPath });
  }

  private onRenameResult(): void {
    this.setStatus('Renamed');
    this.clearSelection();
    this.refresh();
  }

  // Mkdir
  private showMkdirDialog(): void {
    const name = prompt('Directory name:');
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

  private setStatus(text: string): void {
    (this.container.querySelector('#sftp-status-text') as HTMLElement).textContent = text;
  }

  private updateItemCount(count: number): void {
    const dirs = this.entries.filter(e => e.isDir).length;
    const files = this.entries.filter(e => !e.isDir).length;
    (this.container.querySelector('#sftp-item-count') as HTMLElement).textContent =
      `${dirs} dirs, ${files} files`;
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

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  dispose(): void {
    this.container.remove();
  }
}
