import { Env, SSHConnectionConfig, TerminalSize } from '../types';
import { SSHSession } from './ssh-session';

/**
 * SSRF 防护：检测目标主机是否为内网、保留或特殊地址。
 * 覆盖 IPv4 私有段、IPv6 回环/链路本地/私有段、IPv4-mapped IPv6 等。
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().trim();

  // 特殊主机名
  if (h === 'localhost' || h === 'ip6-localhost' || h === 'ip6-loopback') return true;

  // IPv4 私有 / 保留地址
  if (/^(127\.|10\.|0\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;

  // 移除 IPv6 方括号 (e.g. [::1])
  const v6 = h.replace(/^\[|\]$/g, '');

  // IPv6 回环
  if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1') return true;
  // IPv6 未指定地址
  if (v6 === '::' || v6 === '0:0:0:0:0:0:0:0') return true;
  // IPv6 链路本地 (fe80::/10)
  if (/^fe[89ab]/i.test(v6)) return true;
  // IPv6 唯一本地 (fc00::/7)
  if (/^f[cd]/i.test(v6)) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 等)
  const v4mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isBlockedHost(v4mapped[1]);

  return false;
}

export class SSHSessionDO {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<WebSocket, SSHSession> = new Map();
  private _pendingTimeouts: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();
  private pendingTerminalSizes: Map<WebSocket, TerminalSize> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const url = new URL(request.url);
    const configParam = url.searchParams.get('config');
    let prefilledConfig: SSHConnectionConfig | null = null;

    if (configParam) {
      try {
        prefilledConfig = JSON.parse(atob(configParam)) as SSHConnectionConfig;
      } catch {
        return new Response('Invalid config parameter', { status: 400 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);

    if (prefilledConfig) {
      server.serializeAttachment({ state: 'prefilled' });
      queueMicrotask(async () => {
        try {
          await this.initSSHSession(server, prefilledConfig!);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          try {
            server.send(JSON.stringify({ type: 'error', message: `连接失败: ${errMsg}` }));
            server.close(1011, 'SSH connection failed');
          } catch {}
        }
      });
    } else {
      const timeout = setTimeout(() => {
        try {
          server.send(JSON.stringify({ type: 'error', message: 'Connection timeout' }));
          server.close(1011, 'Timeout');
        } catch {}
      }, 10000);

      server.serializeAttachment({ state: 'waiting', timeout: null });
      this._pendingTimeouts.set(server, timeout);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as any);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (session) {
      await session.handleWebSocketMessage(message);
      return;
    }

    if (typeof message !== 'string') {
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid credentials format' }));
      ws.close(1011, 'Invalid format');
      return;
    }

    if (msg.type === 'resize') {
      this.rememberTerminalSize(ws, msg.cols, msg.rows);
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    const timeout = this._pendingTimeouts.get(ws);
    if (timeout) {
      clearTimeout(timeout);
      this._pendingTimeouts.delete(ws);
    }

    const config = msg as SSHConnectionConfig;

    if (!config.host || !config.username || (!config.password && !config.privateKey)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing credentials' }));
      ws.close(1011, 'Invalid credentials');
      return;
    }

    await this.initSSHSession(ws, config);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const session = this.sessions.get(ws);
    if (session) {
      session.close();
      this.sessions.delete(ws);
    }
    const timeout = this._pendingTimeouts.get(ws);
    if (timeout) {
      clearTimeout(timeout);
      this._pendingTimeouts.delete(ws);
    }
    this.pendingTerminalSizes.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1011, 'Error', false);
  }

  private async initSSHSession(
    ws: WebSocket,
    config: SSHConnectionConfig
  ): Promise<void> {
    try {
      // --- SSRF Protection ---
      if (isBlockedHost(config.host)) {
        throw new Error('禁止连接内网或保留地址 (SSRF 防护)');
      }
      const BLOCKED_PORTS = [80, 443, 25, 465, 587, 3306, 6379, 27017, 11211];
      if (BLOCKED_PORTS.includes(config.port)) {
        throw new Error(`端口 ${config.port} 存在安全风险，已被禁止连接`);
      }

      const { connect } = await import('cloudflare:sockets');
      const hostname = config.host.includes(':') ? `[${config.host}]` : config.host;
      const socket = connect({ hostname, port: config.port });

      await socket.opened;

      const strictVerify = this.env.STRICT_HOST_KEY_VERIFY !== 'false';
      const pendingSize = this.pendingTerminalSizes.get(ws);
      if (pendingSize) {
        config.cols = pendingSize.cols;
        config.rows = pendingSize.rows;
      }
      const session = new SSHSession(ws, socket, config, strictVerify);
      this.sessions.set(ws, session);
      this.pendingTerminalSizes.delete(ws);

      await session.startHandshake();

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[SSH] Session error:', errMsg);
      try {
        ws.send(JSON.stringify({ type: 'error', message: `连接失败: ${errMsg}` }));
        ws.close(1011, 'SSH connection failed');
      } catch {}
    }
  }

  private rememberTerminalSize(ws: WebSocket, cols: unknown, rows: unknown): void {
    const size = this.normalizeTerminalSize(cols, rows);
    if (size) this.pendingTerminalSizes.set(ws, size);
  }

  private normalizeTerminalSize(cols: unknown, rows: unknown): TerminalSize | null {
    if (
      typeof cols !== 'number' ||
      typeof rows !== 'number' ||
      !Number.isFinite(cols) ||
      !Number.isFinite(rows)
    ) {
      return null;
    }

    const size = {
      cols: Math.floor(cols),
      rows: Math.floor(rows),
    };

    if (size.cols < 10 || size.cols > 1000 || size.rows < 5 || size.rows > 1000) {
      return null;
    }

    return size;
  }
}
