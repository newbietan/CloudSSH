import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
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
  },
};

export class SSHTerminal {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon!: WebglAddon;
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
  private onSessionClosed?: (event: CloseEvent) => void;
  private restoreCursorBlinkAfterAltScreenExit: boolean = false;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;

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
    this.registerAltScreenExitHandler();

    window.addEventListener('resize', () => this.fit());

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

  async connect(config: SSHConnectionConfig, options: ConnectOptions = {}): Promise<void> {
    this.resetActiveConnection();
    this.lastConfig = config;
    if (options.resetDisplay !== false) {
      this.showConnectingBanner();
    }

    const termStatus = document.getElementById('term-status');
    if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-primary-container animate-pulse"></div> Connected';

    const wsUrl = new URL(window.location.href);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/api/ssh';

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

  connectWithWebSocket(ws: WebSocket): void {
    this.resetActiveConnection();
    this.lastConfig = null;
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
          switch (msg.type) {
            case 'status':
              this.terminal.writeln(`\x1b[32m[*] ${msg.message}\x1b[0m`);
              if (msg.message === '认证成功') {
                this.reconnectAttempts = 0;
                const statusText = document.getElementById('status-text');
                if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-[var(--accent)] inline-block animate-pulse"></span> STATUS: ONLINE';
              }
              break;
            case 'error':
              this.terminal.writeln(`\x1b[31m[!] ${msg.message}\x1b[0m`);
              break;
            case 'debug':
              this.terminal.writeln(`\x1b[90m[DEBUG] ${msg.message}\x1b[0m`);
              break;
            case 'pong':
              break;
          }
        } catch {
          // Non-JSON string data — pass through trzsz filter
          this.trzszFilter!.processServerOutput(event.data);
        }
      } else {
        // Binary data — pass through trzsz filter
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

      if (this.lastConfig && this.reconnectAttempts < this.maxReconnectAttempts) {
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
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
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

  private registerAltScreenExitHandler(): void {
    this.terminalDisposables.push(
      this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (this.hasAltScreenExitParam(params)) {
          this.restoreCursorBlinkAfterAltScreenExit = true;
        }
        return false;
      })
    );

    this.terminalDisposables.push(
      this.terminal.onWriteParsed(() => {
        if (!this.restoreCursorBlinkAfterAltScreenExit) return;
        this.restoreCursorBlinkAfterAltScreenExit = false;
        this.terminal.options.cursorBlink = true;
      })
    );
  }

  private hasAltScreenExitParam(params: (number | number[])[]): boolean {
    return params.some((param) => {
      const values = Array.isArray(param) ? param : [param];
      return values.some(value => value === 47 || value === 1047 || value === 1049);
    });
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
    this.trzszFilter = null;

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
    this.terminalDisposables.forEach(d => d.dispose());
    this.terminalDisposables = [];
    this.terminal.dispose();
  }
}
