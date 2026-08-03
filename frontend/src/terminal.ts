import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { TrzszFilter } from 'trzsz';
import '@xterm/xterm/css/xterm.css';
import { copyTextToClipboard } from './clipboard';
import { t } from './i18n';
import { notify } from './ui-feedback';
import { centerTerminalText } from './terminal-text';
import { localizedSSHMessage } from './terminal-status';
import {
  getActiveTerminalTheme,
  onTerminalThemeChange,
} from './theme';
import {
  applyMobileModifier,
  diffTextareaInput,
  isIOSLike,
  type MobileModifier,
  type MobileTerminalKey,
  mobileTerminalKeySequence,
} from './mobile-input';
import { currentTerminalFontSize } from './terminal-layout';

const TRZSZ_MAX_DATA_CHUNK_SIZE = 2 * 1024 * 1024;

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  authMethod?: 'password' | 'publickey';
  privateKey?: string;
  expectedFingerprint?: string;
  /** 匿名路径手动覆盖的区域偏好（保存服务器路径不使用此字段） */
  locationHint?: string;
}

export interface TerminalSelectionAnchor {
  clientX: number;
  clientY: number;
}

interface ConnectOptions {
  resetDisplay?: boolean;
}

export class SSHTerminal {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon!: WebglAddon;
  private searchAddon: SearchAddon;
  private ws: WebSocket | null = null;
  private container: HTMLElement;
  private disposables: { dispose(): void }[] = [];
  private terminalDisposables: { dispose(): void }[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private trzszFilter: TrzszFilter | null = null;
  private mounted: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastConfig: SSHConnectionConfig | null = null;
  private canReconnect: boolean = true;
  private restoreCursorBlinkAfterReturnPrompt: boolean = false;
  private onSessionClosed?: (event: CloseEvent) => void;
  private onSessionReady?: () => void;
  private onAgentFrameHandler?: (msg: any) => void;
  private sftpAttachUrl: string | null = null;
  private searchBox: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchVisible: boolean = false;
  private cfLatency: number | null = null;
  private cfColo: string | null = null;
  private lastPingTime: number | null = null;
  private wsLatency: number | null = null;
  private onLatencyUpdated?: (cfLatency: number | null, cfColo: string | null, wsLatency: number | null) => void;
  private onSelectionChanged?: (selection: string, anchor: TerminalSelectionAnchor | null) => void;
  private selectionAnchor: TerminalSelectionAnchor | null = null;
  private selectionPointerActive = false;
  private mobileModifier: MobileModifier | null = null;
  private imeTextarea: HTMLTextAreaElement | null = null;
  private imePendingBaseline: string | null = null;
  private imePendingHandled = false;
  private imeKeyupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly contextMenuPasteListener = async (event: MouseEvent): Promise<void> => {
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    event.preventDefault();
    await this.pasteFromClipboard();
  };
  private themeCleanup: () => void;
  private resizeListener: () => void;
  private readonly selectionPointerDownListener = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.selectionPointerActive = true;
    this.selectionAnchor = { clientX: event.clientX, clientY: event.clientY };
  };
  private readonly selectionPointerMoveListener = (event: PointerEvent): void => {
    if (!this.selectionPointerActive) return;
    this.selectionAnchor = { clientX: event.clientX, clientY: event.clientY };
    if (this.terminal.hasSelection()) {
      this.notifySelectionChanged();
    }
  };
  private readonly selectionPointerUpListener = (event: PointerEvent): void => {
    if (!this.selectionPointerActive) return;
    this.selectionPointerActive = false;
    this.selectionAnchor = { clientX: event.clientX, clientY: event.clientY };
    this.notifySelectionChanged();
    const selection = this.terminal.getSelection();
    if (selection && event.pointerType !== 'touch') {
      void this.copySelectionToClipboard(selection);
    }
  };
  private readonly selectionPointerCancelListener = (): void => {
    this.selectionPointerActive = false;
  };

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;
    this.resizeListener = () => this.fit();

    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: currentTerminalFontSize(),
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      theme: getActiveTerminalTheme(),
      allowProposedApi: true,
      scrollback: 10000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);
    this.themeCleanup = onTerminalThemeChange((theme) => {
      this.terminal.options.theme = theme;
    });
    this.registerCursorRestoreHandlers();
    this.terminalDisposables.push(
      this.terminal.onSelectionChange(() => {
        this.notifySelectionChanged();
      }),
    );
    this.container.addEventListener('pointerdown', this.selectionPointerDownListener, true);
    this.container.addEventListener('pointermove', this.selectionPointerMoveListener, true);
    window.addEventListener('pointerup', this.selectionPointerUpListener, true);
    window.addEventListener('pointercancel', this.selectionPointerCancelListener, true);

    // Ctrl+Shift+F to toggle search bar
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        this.toggleSearch();
        return false;
      }
      if (e.key === 'Escape' && this.searchVisible) {
        this.hideSearch();
        return false;
      }
      return true;
    });

    window.addEventListener('resize', this.resizeListener);

    // 右键粘贴（选区已通过鼠标松手自动复制到剪贴板）
    this.container.addEventListener('contextmenu', this.contextMenuPasteListener);

    // Drag-and-drop file upload support (trzsz)
    this.container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.container.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.trzszFilter && e.dataTransfer?.items) {
        this.trzszFilter.uploadFiles(e.dataTransfer.items)
          .then(() => console.log('[trzsz] Drag-drop upload success'))
          .catch((err: any) => console.error('[trzsz] Drag-drop upload error:', err));
      }
    });
  }

  setSessionClosedHandler(handler: (event: CloseEvent) => void): void {
    this.onSessionClosed = handler;
  }

  setSessionReadyHandler(handler: () => void): void {
    this.onSessionReady = handler;
  }

  setAgentFrameHandler(handler: (msg: any) => void): void {
    this.onAgentFrameHandler = handler;
  }

  sendWebSocketMessage(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /** 通过与物理键盘相同的 trzsz 输入管线发送移动端快捷键。 */
  sendInput(data: string): boolean {
    if (!data || this.ws?.readyState !== WebSocket.OPEN || !this.trzszFilter) return false;
    this.processTerminalInput(data);
    this.terminal.focus();
    return true;
  }

  /** 按 xterm 当前 application cursor mode 发送移动端功能键。 */
  sendMobileKey(key: MobileTerminalKey): boolean {
    const data = mobileTerminalKeySequence(
      key,
      this.terminal.modes.applicationCursorKeysMode,
      this.mobileModifier,
    );
    this.setMobileModifier(null);
    return this.sendInput(data);
  }

  setMobileModifier(modifier: MobileModifier | null): void {
    this.mobileModifier = modifier;
    this.container.dispatchEvent(new CustomEvent('cloudssh:mobile-modifier-change', { bubbles: true }));
  }

  getMobileModifier(): MobileModifier | null {
    return this.mobileModifier;
  }

  focus(): void {
    this.terminal.focus();
  }

  blur(): void {
    this.imeTextarea?.blur();
  }

  async copyCurrentSelection(): Promise<boolean> {
    const selection = this.terminal.getSelection();
    if (!selection) {
      notify(t('terminal.noSelection'), { variant: 'info' });
      return false;
    }
    await this.copySelectionToClipboard(selection);
    return true;
  }

  async pasteFromClipboard(): Promise<boolean> {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || this.ws?.readyState !== WebSocket.OPEN) return false;
      // xterm 会统一换行，并且仅在远端显式启用 bracketed paste 时添加控制序列。
      // paste() 还会经过 onData/trzsz 输入管线，与键盘粘贴保持一致。
      this.setMobileModifier(null);
      this.terminal.paste(text);
      return true;
    } catch (err) {
      console.error('Failed to read clipboard', err);
      notify(t('terminal.pasteFailed'), { variant: 'danger' });
      return false;
    }
  }

  /** 将文本填入当前远端终端输入行，不附加回车。 */
  fillInput(text: string): boolean {
    if (!text || /[\r\n]/.test(text)) return false;
    if (this.ws?.readyState !== WebSocket.OPEN || !this.trzszFilter) return false;

    this.trzszFilter.processTerminalInput(text);
    this.terminal.focus();
    return true;
  }

  setLatencyUpdatedHandler(handler: (cfLatency: number | null, cfColo: string | null, wsLatency: number | null) => void): void {
    this.onLatencyUpdated = handler;
    if (this.cfLatency !== null || this.cfColo !== null || this.wsLatency !== null) {
      handler(this.cfLatency, this.cfColo, this.wsLatency);
    }
  }

  setSelectionChangeHandler(handler: (selection: string, anchor: TerminalSelectionAnchor | null) => void): void {
    this.onSelectionChanged = handler;
    this.notifySelectionChanged();
  }

  clearSelection(): void {
    this.terminal.clearSelection();
    this.selectionAnchor = null;
    this.notifySelectionChanged();
  }

  getSFTPWebSocketUrl(): string | null {
    return this.sftpAttachUrl;
  }

  private notifySelectionChanged(): void {
    const selection = this.terminal.getSelection();
    if (!selection) {
      this.selectionAnchor = null;
    }
    this.onSelectionChanged?.(selection, this.selectionAnchor);
  }

  /** 将选中文字写入剪贴板，并按实际复制结果提供反馈。 */
  private async copySelectionToClipboard(text: string): Promise<void> {
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      notify(t('terminal.copyFailed'), { variant: 'danger' });
      return;
    }
    notify(t('terminal.copySuccess'), { variant: 'success', duration: 1500 });
  }

  mount(): void {
    if (this.mounted) {
      this.fit();
      return;
    }

    this.terminal.open(this.container);
    this.mounted = true;
    this.installIOSIMEFallback();
    
    // Load WebGL addon after terminal is opened
    try {
      this.webglAddon = new WebglAddon();
      this.webglAddon.onContextLoss(e => {
        console.warn('WebGL context lost', e);
        this.webglAddon.dispose();
      });
      this.terminal.loadAddon(this.webglAddon);
    } catch (e) {
      console.warn('WebGL addon failed to load, falling back to canvas/dom', e);
    }

    this.fit();
  }

  private createSearchBox(): void {
    if (this.searchBox) return;

    const box = document.createElement('div');
    box.className = 'cloudssh-search-box';
    box.style.display = 'none';
    box.innerHTML = `
      <input type="text" class="cloudssh-search-input" placeholder="${t('terminal.searchPlaceholder')}" />
      <button class="cloudssh-search-btn cloudssh-search-prev" title="${t('terminal.searchPrevious')}">
        <span class="material-symbols-outlined" style="font-size:16px;">arrow_upward</span>
      </button>
      <button class="cloudssh-search-btn cloudssh-search-next" title="${t('terminal.searchNext')}">
        <span class="material-symbols-outlined" style="font-size:16px;">arrow_downward</span>
      </button>
      <button class="cloudssh-search-btn cloudssh-search-close" title="${t('terminal.searchClose')}">
        <span class="material-symbols-outlined" style="font-size:16px;">close</span>
      </button>
    `;

    this.container.style.position = 'relative';
    this.container.appendChild(box);
    this.searchBox = box;
    this.searchInput = box.querySelector('.cloudssh-search-input') as HTMLInputElement;

    // Search on input
    this.searchInput.addEventListener('input', () => {
      const term = this.searchInput!.value;
      if (term) {
        this.searchAddon.findNext(term, { incremental: true });
      }
    });

    // Enter = next, Shift+Enter = previous
    this.searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      const term = this.searchInput!.value;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          this.searchAddon.findPrevious(term);
        } else {
          this.searchAddon.findNext(term);
        }
      }
    });

    // Button handlers
    box.querySelector('.cloudssh-search-prev')!.addEventListener('click', () => {
      const term = this.searchInput!.value;
      if (term) this.searchAddon.findPrevious(term);
    });
    box.querySelector('.cloudssh-search-next')!.addEventListener('click', () => {
      const term = this.searchInput!.value;
      if (term) this.searchAddon.findNext(term);
    });
    box.querySelector('.cloudssh-search-close')!.addEventListener('click', () => {
      this.hideSearch();
    });
  }

  toggleSearch(): void {
    if (this.searchVisible) {
      this.hideSearch();
    } else {
      this.showSearch();
    }
  }

  showSearch(): void {
    this.createSearchBox();
    if (!this.searchBox) return;
    this.searchBox.style.display = 'flex';
    this.searchVisible = true;
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  hideSearch(): void {
    if (!this.searchBox) return;
    this.searchBox.style.display = 'none';
    this.searchVisible = false;
    this.terminal.focus();
  }

  // ==================== known_hosts (TOFU) ====================

  private handleHostKey(fingerprint: string): void {
    if (!this.lastConfig) return;
    const key = `${this.lastConfig.host}:${this.lastConfig.port}`;

    // 存储到 localStorage（匿名用户）
    try {
      const raw = localStorage.getItem('cloudssh_known_hosts');
      const map = raw ? JSON.parse(raw) : {};
      map[key] = fingerprint;
      localStorage.setItem('cloudssh_known_hosts', JSON.stringify(map));
    } catch { /* ignore */ }

    // 尝试存储到云端（登录用户）
    fetch('/api/known-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: this.lastConfig.host,
        port: this.lastConfig.port,
        fingerprint,
      }),
    }).catch(() => { /* 未登录或网络错误，忽略 */ });
  }

  async connect(config: SSHConnectionConfig, options: ConnectOptions = {}): Promise<void> {
    this.resetActiveConnection();
    this.lastConfig = config;
    this.canReconnect = true;
    if (options.resetDisplay !== false) {
      this.showConnectingBanner();
    }

    const termStatus = document.getElementById('term-status');
    if (termStatus) termStatus.innerHTML = `<div class="w-2 h-2 bg-primary-container animate-pulse"></div> ${t('terminal.connecting')}`;

    const wsUrl = new URL(window.location.href);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/api/ssh';
    // 匿名路径：用户在前端选定 region 后作为 URL query 传给 Worker；
    // Worker 在 get() 前读取并传入 locationHint（仅手动覆盖路径）
    if (config.locationHint) {
      wsUrl.searchParams.set('region', config.locationHint);
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl.toString());
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.terminal.writeln(`\x1b[32m[+] ${t('terminal.wsSendingCredentials')}\x1b[0m`);
        this.ws?.send(JSON.stringify({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          authMethod: config.authMethod,
          privateKey: config.privateKey,
          expectedFingerprint: config.expectedFingerprint,
          ...this.getTerminalSize(),
        }));
        
        this.startHeartbeat();
        resolve();
      };

      this.ws.onerror = () => {
        reject(new Error(t('terminal.wsFailed')));
      };

      this.setupWebSocketHandlers(reject);
    });
  }

  connectWithWebSocket(ws: WebSocket, hostInfo?: { host: string; port: number }): void {
    this.resetActiveConnection();
    this.lastConfig = hostInfo ? { host: hostInfo.host, port: hostInfo.port, username: '' } : null;
    this.canReconnect = false;
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.showConnectingBanner();

    const termStatus = document.getElementById('term-status');
    if (termStatus) termStatus.innerHTML = `<div class="w-2 h-2 bg-primary-container animate-pulse"></div> ${t('terminal.connecting')}`;

    ws.onopen = () => {
      this.terminal.writeln(`\x1b[32m[+] ${t('terminal.wsAuthenticating')}\x1b[0m`);
      this.sendResize();
      this.startHeartbeat();
    };

    if (ws.readyState === WebSocket.OPEN) {
      this.sendResize();
    }

    this.setupWebSocketHandlers();
  }

  private setupWebSocketHandlers(rejectFn?: (reason?: any) => void): void {
    if (!this.ws) return;
    const socket = this.ws;

    // Trzsz file transfer support
    this.trzszFilter = new TrzszFilter({
      writeToTerminal: (data: string | ArrayBuffer | Uint8Array | Blob) => {
        if (typeof data === 'string') {
          this.terminal.write(data);
        } else if (data instanceof Uint8Array) {
          this.terminal.write(data);
        } else if (data instanceof ArrayBuffer) {
          this.terminal.write(new Uint8Array(data));
        } else if (data instanceof Blob) {
          data.arrayBuffer().then(buf => this.terminal.write(new Uint8Array(buf)));
        }
      },
      sendToServer: (data: string | Uint8Array) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(data);
        }
      },
      terminalColumns: this.terminal.cols,
      maxDataChunkSize: TRZSZ_MAX_DATA_CHUNK_SIZE,
    });

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'sftp_attach') {
            this.sftpAttachUrl = msg.url || null;
            return;
          }

          if (msg.type === 'agent_frame') {
            this.onAgentFrameHandler?.(msg);
            return;
          }

          switch (msg.type) {
            case 'status':
              this.terminal.writeln(`\x1b[32m[*] ${localizedSSHMessage(msg.message, msg.event, msg.params)}\x1b[0m`);
              if (msg.event === 'auth_success' || msg.message === '认证成功') {
                this.reconnectAttempts = 0;
                const statusText = document.getElementById('status-text');
                if (statusText) statusText.innerHTML = `<span class="w-2 h-2 bg-[var(--accent)] inline-block animate-pulse"></span> ${t('auth.statusOnline')}`;
              }
              if (msg.event === 'shell_ready' || msg.message === 'Shell 已就绪') {
                this.onSessionReady?.();
              }
              break;
            case 'error':
              this.terminal.writeln(`\x1b[31m[!] ${localizedSSHMessage(msg.message, msg.event, msg.params)}\x1b[0m`);
              break;
            case 'debug':
              this.terminal.writeln(`\x1b[90m[DEBUG] ${msg.message}\x1b[0m`);
              break;
            case 'host_key':
              this.handleHostKey(msg.fingerprint);
              break;
            case 'pong':
              if (this.lastPingTime !== null) {
                this.wsLatency = Math.round(performance.now() - this.lastPingTime);
                this.lastPingTime = null;
                this.onLatencyUpdated?.(this.cfLatency, this.cfColo, this.wsLatency);
              }
              break;
            case 'rtt':
              this.cfLatency = msg.latency;
              this.cfColo = msg.colo;
              this.onLatencyUpdated?.(this.cfLatency, this.cfColo, this.wsLatency);
              break;
          }
        } catch {
          // Non-JSON string data — pass through trzsz filter
          this.trzszFilter!.processServerOutput(event.data);
        }
      } else {
        this.trzszFilter!.processServerOutput(event.data);
      }
    };

    this.ws.onclose = (event) => {
      if (socket !== this.ws) return;

      this.stopHeartbeat();
      this.terminal.writeln(
        `\x1b[33m[*] ${t('terminal.connectionClosed', { code: event.code })}\x1b[0m`
      );
      const termStatus = document.getElementById('term-status');
      if (termStatus) termStatus.innerHTML = `<div class="w-2 h-2 bg-[var(--error)]"></div> ${t('terminal.disconnected')}`;
      const statusText = document.getElementById('status-text');
      if (statusText) statusText.innerHTML = `<span class="w-2 h-2 bg-surface-dot inline-block"></span> ${t('auth.statusOffline')}`;
      
      if (event.code === 1000) {
        this.onSessionClosed?.(event);
        return;
      }

      if (this.canReconnect && this.lastConfig && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.terminal.writeln(`\x1b[31m[!] ${t('terminal.connectionError')}\x1b[0m`);
      if (rejectFn) rejectFn(new Error(t('terminal.wsFailed')));
    };

    // User input goes through trzsz filter
    this.disposables.push(
      this.terminal.onData((data) => {
        if (this.imePendingBaseline !== null && data) {
          this.imePendingHandled = true;
        }
        this.processTerminalInput(data);
      })
    );

    // Binary input support
    this.disposables.push(
      this.terminal.onBinary((data) => {
        this.trzszFilter!.processBinaryInput(data);
      })
    );

    // Terminal resize: send to server + update trzsz column count
    this.disposables.push(
      this.terminal.onResize(({ cols, rows }) => {
        this.sendResize({ cols, rows });
        this.trzszFilter?.setTerminalColumns(cols);
      })
    );
  }

  fit(): void {
    const fontSize = currentTerminalFontSize();
    if (this.terminal.options.fontSize !== fontSize) {
      this.terminal.options.fontSize = fontSize;
    }
    if (!this.mounted || this.container.clientWidth === 0 || this.container.clientHeight === 0) return;
    this.fitAddon.fit();
  }

  private processTerminalInput(data: string): void {
    if (!this.trzszFilter) return;
    const transformed = applyMobileModifier(data, this.mobileModifier);
    if (transformed.consumed) this.setMobileModifier(null);
    this.trzszFilter.processTerminalInput(transformed.data);
  }

  /**
   * xterm.js 6.0 尚未包含上游 keyCode=229 keyup 修复。这里只在 iOS-like
   * 环境补发 xterm 未观察到的 textarea 差异；若 xterm 已产生 onData 则不重复发送。
   */
  private installIOSIMEFallback(): void {
    if (this.imeTextarea) return;
    const textarea = this.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (!textarea) return;
    this.imeTextarea = textarea;
    textarea.setAttribute('enterkeyhint', 'enter');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.spellcheck = false;
    if (!isIOSLike(navigator)) return;
    textarea.addEventListener('keydown', this.imeKeydownListener, true);
    textarea.addEventListener('keyup', this.imeKeyupListener, true);
    textarea.addEventListener('compositionstart', this.imeCompositionStartListener, true);
  }

  private readonly imeKeydownListener = (event: KeyboardEvent): void => {
    if (event.keyCode !== 229 || !this.imeTextarea) return;
    if (this.imePendingBaseline === null) {
      this.imePendingBaseline = this.imeTextarea.value;
      this.imePendingHandled = false;
    }
  };

  private readonly imeKeyupListener = (event: KeyboardEvent): void => {
    if (event.keyCode !== 229 || this.imePendingBaseline === null) return;
    if (this.imeKeyupTimer !== null) clearTimeout(this.imeKeyupTimer);
    // 让 xterm 自己在 keyup 或先前的 0ms fallback 中优先消费输入。
    this.imeKeyupTimer = setTimeout(() => {
      this.imeKeyupTimer = null;
      if (!this.imePendingHandled && this.imeTextarea && this.imePendingBaseline !== null) {
        const diff = diffTextareaInput(this.imePendingBaseline, this.imeTextarea.value);
        if (diff) this.sendInput(diff);
      }
      this.clearIMEPendingInput();
    }, 0);
  };

  private readonly imeCompositionStartListener = (): void => {
    this.clearIMEPendingInput();
  };

  private clearIMEPendingInput(): void {
    if (this.imeKeyupTimer !== null) {
      clearTimeout(this.imeKeyupTimer);
      this.imeKeyupTimer = null;
    }
    this.imePendingBaseline = null;
    this.imePendingHandled = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const sendPing = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.lastPingTime = performance.now();
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    };
    sendPing();
    this.heartbeatInterval = setInterval(sendPing, 30000);
  }

  private getTerminalSize(): { cols: number; rows: number } {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  private sendResize(size = this.getTerminalSize()): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'resize',
        ...size,
      }));
    }
  }

  private registerCursorRestoreHandlers(): void {
    this.terminalDisposables.push(
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (params[0] === 2004 && this.terminal.buffer.active.type === 'normal') {
          this.restoreCursorBlinkAfterReturnPrompt = true;
        }
        return false;
      })
    );

    this.terminalDisposables.push(
      this.terminal.onWriteParsed(() => {
        if (!this.restoreCursorBlinkAfterReturnPrompt) return;
        this.restoreCursorBlinkAfterReturnPrompt = false;
        this.terminal.options.cursorBlink = true;
      })
    );
  }

  private resetTerminalDisplay(): void {
    this.terminal.reset();
    this.terminal.options.cursorBlink = true;
    this.terminal.write('\x1b[2J\x1b[3J\x1b[H');
  }

  private showConnectingBanner(): void {
    this.resetTerminalDisplay();
    const bannerText = centerTerminalText(t('terminal.bannerConnecting'), 34);
    this.terminal.write(
      '\x1b[1;33m╔══════════════════════════════════╗\x1b[0m\r\n' +
      `\x1b[1;33m║${bannerText}║\x1b[0m\r\n` +
      '\x1b[1;33m╚══════════════════════════════════╝\x1b[0m\r\n\r\n'
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private disposeConnectionDisposables(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private resetActiveConnection(): void {
    this.stopHeartbeat();
    this.clearReconnectTimeout();
    this.disposeConnectionDisposables();

    const socket = this.ws;
    this.ws = null;
    this.sftpAttachUrl = null;
    this.trzszFilter = null;

    this.cfLatency = null;
    this.cfColo = null;
    this.lastPingTime = null;
    this.wsLatency = null;

    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close(1000);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimeout();
    
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    this.terminal.writeln(`\x1b[33m[*] ${t('terminal.reconnectWait', { seconds: delay / 1000, attempt: this.reconnectAttempts, max: this.maxReconnectAttempts })}\x1b[0m`);
    
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      if (this.lastConfig) {
        this.terminal.writeln(`\x1b[32m[+] ${t('terminal.reconnecting')}\x1b[0m`);
        try {
          await this.connect(this.lastConfig, { resetDisplay: false });
        } catch (e) {
          this.terminal.writeln(`\x1b[31m[!] ${t('terminal.reconnectFailed')}\x1b[0m`);
        }
      }
    }, delay);
  }

  disconnect(): void {
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.resetActiveConnection();
    this.lastConfig = null;
    this.resetTerminalDisplay();
  }

  dispose(): void {
    this.disconnect();
    window.removeEventListener('resize', this.resizeListener);
    this.container.removeEventListener('pointerdown', this.selectionPointerDownListener, true);
    this.container.removeEventListener('pointermove', this.selectionPointerMoveListener, true);
    window.removeEventListener('pointerup', this.selectionPointerUpListener, true);
    window.removeEventListener('pointercancel', this.selectionPointerCancelListener, true);
    this.container.removeEventListener('contextmenu', this.contextMenuPasteListener);
    this.imeTextarea?.removeEventListener('keydown', this.imeKeydownListener, true);
    this.imeTextarea?.removeEventListener('keyup', this.imeKeyupListener, true);
    this.imeTextarea?.removeEventListener('compositionstart', this.imeCompositionStartListener, true);
    this.clearIMEPendingInput();
    this.imeTextarea = null;
    this.themeCleanup();
    this.terminalDisposables.forEach(d => d.dispose());
    this.terminalDisposables = [];
    this.terminal.dispose();
  }

  exportToFile(filename?: string): void {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    let actualFilename = filename;
    if (!actualFilename) {
      const host = this.lastConfig?.host || 'terminal';
      const port = this.lastConfig?.port || '';
      const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
      actualFilename = `${host}_${port}_${dateStr}.txt`;
    }
    
    a.download = actualFilename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

// ==================== known_hosts 辅助函数 ====================

/**
 * 加载已知主机指纹（TOFU 验证用）
 * 优先从云端（登录用户）加载，回退到 localStorage（匿名用户）
 */
export async function loadKnownFingerprint(host: string, port: number): Promise<string | null> {
  // 先尝试云端（登录用户）
  try {
    const res = await fetch(`/api/known-hosts?host=${encodeURIComponent(host)}&port=${port}`);
    if (res.ok) {
      const data = await res.json() as { fingerprint: string | null };
      if (data.fingerprint) return data.fingerprint;
    }
  } catch { /* 未登录或网络错误 */ }

  // 回退到 localStorage
  try {
    const raw = localStorage.getItem('cloudssh_known_hosts');
    if (raw) {
      const map = JSON.parse(raw) as Record<string, string>;
      return map[`${host}:${port}`] || null;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * 清除已知主机指纹（用于主机密钥变更后重新信任）
 */
export async function clearKnownFingerprint(host: string, port: number): Promise<void> {
  // 清除 localStorage
  try {
    const raw = localStorage.getItem('cloudssh_known_hosts');
    if (raw) {
      const map = JSON.parse(raw) as Record<string, string>;
      delete map[`${host}:${port}`];
      localStorage.setItem('cloudssh_known_hosts', JSON.stringify(map));
    }
  } catch { /* ignore */ }

  // 清除云端
  try {
    await fetch('/api/known-hosts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port }),
    });
  } catch { /* 未登录或网络错误 */ }
}
