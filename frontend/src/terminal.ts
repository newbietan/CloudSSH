import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { TrzszFilter } from 'trzsz';
import '@xterm/xterm/css/xterm.css';

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  authMethod?: 'password' | 'publickey';
  privateKey?: string;
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

export class SSHTerminal {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon!: WebglAddon;
  private ws: WebSocket | null = null;
  private container: HTMLElement;
  private disposables: { dispose(): void }[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private trzszFilter: TrzszFilter | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastConfig: SSHConnectionConfig | null = null;

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
  }

  mount(): void {
    this.terminal.open(this.container);
    
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

    this.terminal.writeln('\x1b[1;33m╔══════════════════════════════════╗\x1b[0m');
    this.terminal.writeln('\x1b[1;33m║      Connecting to CloudSSH      ║\x1b[0m');
    this.terminal.writeln('\x1b[1;33m╚══════════════════════════════════╝\x1b[0m');
    this.terminal.writeln('');
  }

  async connect(config: SSHConnectionConfig): Promise<void> {
    this.resetActiveConnection();
    this.lastConfig = config;
    this.terminal.clear();

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

      this.ws.onclose = () => {
        this.terminal.writeln('\x1b[31m[-] 连接已关闭\x1b[0m');
        const statusText = document.getElementById('status-text');
        if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-[#353534] inline-block"></span> STATUS: OFFLINE';
      };

      this.setupWebSocketHandlers(reject);
    });
  }

  /**
   * 通过已创建的 WebSocket 连接（用于 one-time-token 模式）
   * 服务器已通过 token 获取凭据，无需前端发送
   */
  connectWithWebSocket(ws: WebSocket): void {
    this.resetActiveConnection();
    this.lastConfig = null;
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.terminal.clear();

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
                if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-[#4af626] inline-block animate-pulse"></span> STATUS: ONLINE';
              }
              break;
            case 'error':
              this.terminal.writeln(`\x1b[31m[!] ${msg.message}\x1b[0m`);
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
      this.stopHeartbeat();
      this.terminal.writeln(
        `\x1b[33m[*] Connection closed (code=${event.code})\x1b[0m`
      );
      const termStatus = document.getElementById('term-status');
      if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-red-500"></div> Disconnected';
      const statusText = document.getElementById('status-text');
      if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-[#353534] inline-block"></span> STATUS: OFFLINE';
      
      if (event.code !== 1000 && this.lastConfig && this.reconnectAttempts < this.maxReconnectAttempts) {
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

    if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
      this.ws.close(1000);
    }
    this.ws = null;
    this.trzszFilter = null;
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
          await this.connect(this.lastConfig);
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
    this.terminal.clear();
  }

  dispose(): void {
    this.disconnect();
    this.terminal.dispose();
  }
}
