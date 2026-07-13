import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { TrzszFilter } from 'trzsz';
import '@xterm/xterm/css/xterm.css';

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

interface ConnectOptions {
  resetDisplay?: boolean;
}

export const THEMES = {
  cyberpunk: {
    background: '#0a0a0a',
    foreground: '#4af626',
    cursor: '#14d1ff',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#273747',
  },
  glacier: {
    background: '#0a192f',
    foreground: '#64ffda',
    cursor: '#e6f1ff',
    cursorAccent: '#0a192f',
    selectionBackground: '#112240',
  },
  gruvbox: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#d3869b',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
  }
};

export const UI_THEMES: Record<keyof typeof THEMES, Record<string, string>> = {
  cyberpunk: {
    '--bg': '#0a0a0a',
    '--bg-surface': '#121212',
    '--bg-elevated': '#131313',
    '--bg-terminal': '#0e0e0e',
    '--text': '#4af626',
    '--text-muted': '#bbccb0',
    '--text-dim': '#3c4b36',
    '--accent': '#4af626',
    '--accent-secondary': '#14d1ff',
    '--accent-secondary-light': '#b7eaff',
    '--border': '#1f1f1f',
    '--border-strong': '#3c4b36',
    '--error': '#ffb4ab',
    '--error-bg': '#93000a',
    '--on-accent': '#022100',
    '--surface-dot': '#353534',
    '--scrollbar-track': 'rgba(28, 27, 27, 0.5)',
    '--scrollbar-thumb': 'rgba(60, 75, 54, 0.8)',
    '--scrollbar-thumb-hover': 'rgba(134, 149, 125, 0.8)',
    '--scanline-tint': 'rgba(74, 246, 38, 0.02)',
    '--accent-glow': 'rgba(74, 246, 38, 0.08)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.8)',
    '--on-surface': '#e5e2e1',
    '--on-surface-variant': '#bbccb0',
    '--agent-user-color': '#4af626',
    '--agent-agent-color': '#14d1ff',
  },
  glacier: {
    '--bg': '#0a192f',
    '--bg-surface': '#0d2137',
    '--bg-elevated': '#112240',
    '--bg-terminal': '#061526',
    '--text': '#64ffda',
    '--text-muted': '#8892b0',
    '--text-dim': '#495670',
    '--accent': '#64ffda',
    '--accent-secondary': '#e6f1ff',
    '--accent-secondary-light': '#ccd6f6',
    '--border': '#1d3557',
    '--border-strong': '#495670',
    '--error': '#ff6b6b',
    '--error-bg': '#3d0000',
    '--on-accent': '#0a192f',
    '--surface-dot': '#1d3557',
    '--scrollbar-track': 'rgba(10, 25, 47, 0.5)',
    '--scrollbar-thumb': 'rgba(100, 255, 218, 0.2)',
    '--scrollbar-thumb-hover': 'rgba(100, 255, 218, 0.4)',
    '--scanline-tint': 'rgba(100, 255, 218, 0.02)',
    '--accent-glow': 'rgba(100, 255, 218, 0.08)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.85)',
    '--on-surface': '#e6f1ff',
    '--on-surface-variant': '#8892b0',
    '--agent-user-color': '#64ffda',
    '--agent-agent-color': '#e6f1ff',
  },
  gruvbox: {
    '--bg': '#282828',
    '--bg-surface': '#303030',
    '--bg-elevated': '#282828',
    '--bg-terminal': '#1d2021',
    '--text': '#ebdbb2',
    '--text-muted': '#a89984',
    '--text-dim': '#665c54',
    '--accent': '#b8bb26',
    '--accent-secondary': '#83a598',
    '--accent-secondary-light': '#8ec07c',
    '--border': '#3c3836',
    '--border-strong': '#665c54',
    '--error': '#fb4934',
    '--error-bg': '#3d0000',
    '--on-accent': '#282828',
    '--surface-dot': '#3c3836',
    '--scrollbar-track': 'rgba(40, 40, 40, 0.5)',
    '--scrollbar-thumb': 'rgba(168, 153, 132, 0.3)',
    '--scrollbar-thumb-hover': 'rgba(168, 153, 132, 0.5)',
    '--scanline-tint': 'rgba(184, 187, 38, 0.02)',
    '--accent-glow': 'rgba(184, 187, 38, 0.08)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.75)',
    '--on-surface': '#ebdbb2',
    '--on-surface-variant': '#a89984',
    '--agent-user-color': '#b8bb26',
    '--agent-agent-color': '#83a598',
  },
};

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
  private resizeListener: () => void;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;
    this.resizeListener = () => this.fit();

    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      theme: THEMES.cyberpunk,
      allowProposedApi: true,
      scrollback: 10000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);
    this.registerCursorRestoreHandlers();

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

    // Right-click paste support
    this.container.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(text);
        }
      } catch (err) {
        console.error('Failed to read clipboard', err);
      }
    });

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

  setTheme(themeName: keyof typeof THEMES): void {
    this.terminal.options.theme = THEMES[themeName];
    const uiVars = UI_THEMES[themeName];
    if (uiVars) {
      const root = document.documentElement;
      Object.entries(uiVars).forEach(([prop, val]) => {
        root.style.setProperty(prop, val);
      });
    }
    localStorage.setItem('cloudssh_theme', themeName);
  }

  applyImportedTheme(data: { terminal?: Record<string, string>; ui?: Record<string, string> }): void {
    if (data.terminal) {
      this.terminal.options.theme = data.terminal as any;
    }
    if (data.ui) {
      const root = document.documentElement;
      Object.entries(data.ui).forEach(([prop, val]) => {
        root.style.setProperty(prop, val);
      });
    }
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

  setLatencyUpdatedHandler(handler: (cfLatency: number | null, cfColo: string | null, wsLatency: number | null) => void): void {
    this.onLatencyUpdated = handler;
    if (this.cfLatency !== null || this.cfColo !== null || this.wsLatency !== null) {
      handler(this.cfLatency, this.cfColo, this.wsLatency);
    }
  }

  getSFTPWebSocketUrl(): string | null {
    return this.sftpAttachUrl;
  }

  mount(): void {
    if (this.mounted) {
      this.fit();
      return;
    }

    this.terminal.open(this.container);
    this.mounted = true;
    
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
      <input type="text" class="cloudssh-search-input" placeholder="Search..." />
      <button class="cloudssh-search-btn cloudssh-search-prev" title="Previous (Shift+Enter)">
        <span class="material-symbols-outlined" style="font-size:16px;">arrow_upward</span>
      </button>
      <button class="cloudssh-search-btn cloudssh-search-next" title="Next (Enter)">
        <span class="material-symbols-outlined" style="font-size:16px;">arrow_downward</span>
      </button>
      <button class="cloudssh-search-btn cloudssh-search-close" title="Close (Esc)">
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
    if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-primary-container animate-pulse"></div> Connected';

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
        this.terminal.writeln('\x1b[32m[+] WebSocket connected, sending credentials...\x1b[0m');
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
        reject(new Error('WebSocket connection failed'));
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
    if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-primary-container animate-pulse"></div> Connected';

    ws.onopen = () => {
      this.terminal.writeln('\x1b[32m[+] WebSocket connected, authenticating...\x1b[0m');
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
              this.terminal.writeln(`\x1b[32m[*] ${msg.message}\x1b[0m`);
              if (msg.event === 'auth_success' || msg.message === '认证成功') {
                this.reconnectAttempts = 0;
                const statusText = document.getElementById('status-text');
                if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-[var(--accent)] inline-block animate-pulse"></span> STATUS: ONLINE';
              }
              if (msg.event === 'shell_ready' || msg.message === 'Shell 已就绪') {
                this.onSessionReady?.();
              }
              break;
            case 'error':
              this.terminal.writeln(`\x1b[31m[!] ${msg.message}\x1b[0m`);
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
        `\x1b[33m[*] Connection closed (code=${event.code})\x1b[0m`
      );
      const termStatus = document.getElementById('term-status');
      if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-[var(--error)]"></div> Disconnected';
      const statusText = document.getElementById('status-text');
      if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-surface-dot inline-block"></span> STATUS: OFFLINE';
      
      if (event.code === 1000) {
        this.onSessionClosed?.(event);
        return;
      }

      if (this.canReconnect && this.lastConfig && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.terminal.writeln('\x1b[31m[!] Connection error\x1b[0m');
      if (rejectFn) rejectFn(new Error('WebSocket connection failed'));
    };

    // User input goes through trzsz filter
    this.disposables.push(
      this.terminal.onData((data) => {
        this.trzszFilter!.processTerminalInput(data);
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
    this.fitAddon.fit();
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
    this.terminal.write(
      '\x1b[1;33m╔══════════════════════════════════╗\x1b[0m\r\n' +
      '\x1b[1;33m║      Connecting to CloudSSH      ║\x1b[0m\r\n' +
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
    
    this.terminal.writeln(`\x1b[33m[*] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...\x1b[0m`);
    
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      if (this.lastConfig) {
        this.terminal.writeln('\x1b[32m[+] Reconnecting...\x1b[0m');
        try {
          await this.connect(this.lastConfig, { resetDisplay: false });
        } catch (e) {
          this.terminal.writeln('\x1b[31m[!] Reconnect failed\x1b[0m');
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
