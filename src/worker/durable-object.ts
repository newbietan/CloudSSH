import { Env, SSHConnectionConfig, TerminalSize, normalizeTerminalSize } from '../types';
import { SSHSession } from './ssh-session';
import { checkHostResolved } from './dns-check';

/**
 * SSRF 防护：检测目标主机是否为内网、保留或特殊地址。
 * 覆盖 IPv4 私有段、IPv6 回环/链路本地/私有段、IPv4-mapped IPv6 等。
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().trim();

  // 特殊主机名
  if (h === 'localhost' || h === 'ip6-localhost' || h === 'ip6-loopback') return true;
  if (h === '0.0.0.0' || h === '255.255.255.255' || h === 'broadcasthost') return true;

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
  private sftpSessions: Map<WebSocket, SSHSession> = new Map();
  private sftpAttachTokens: Map<string, SSHSession> = new Map();
  private _pendingTimeouts: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();
  private pendingTerminalSizes: Map<WebSocket, TerminalSize> = new Map();
  private pendingAttachUrls: Map<WebSocket, string> = new Map();
  private websocketColos: Map<WebSocket, string> = new Map();

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
    if (url.pathname === '/api/ssh/sftp') {
      return this.handleSFTPAttach(request, url);
    }

    let prefilledConfig: SSHConnectionConfig | null = null;
    const sessionName = url.searchParams.get('session') || `session:${Date.now()}:${Math.random()}`;

    if (request.method === 'POST') {
      try {
        prefilledConfig = await request.json<SSHConnectionConfig>();
      } catch {
        return new Response('Invalid request body', { status: 400 });
      }
    } else {
      const headerConfig = request.headers.get('x-ssh-config');

      if (headerConfig) {
        try {
          prefilledConfig = JSON.parse(decodeURIComponent(headerConfig)) as SSHConnectionConfig;
        } catch {
          return new Response('Invalid config header', { status: 400 });
        }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const colo = request.headers.get('x-cloudflare-colo') || 'UNKNOWN';
    this.websocketColos.set(server, colo);

    this.state.acceptWebSocket(server);
    const attachToken = crypto.randomUUID();
    const sftpAttachUrl = this.buildSFTPAttachUrl(url, sessionName, attachToken);
    this.pendingAttachUrls.set(server, sftpAttachUrl);

    if (prefilledConfig) {
      server.serializeAttachment({ state: 'prefilled' });
      queueMicrotask(async () => {
        try {
          await this.initSSHSession(server, prefilledConfig!, attachToken);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          try {
            server.send(JSON.stringify({ type: 'error', message: `连接失败: ${errMsg}` }));
            server.close(1011, 'SSH connection failed');
          } catch (e) { console.error('Failed to notify client of connection error:', e); }
        }
      });
    } else {
      const timeout = setTimeout(() => {
        try {
          server.send(JSON.stringify({ type: 'error', message: 'Connection timeout' }));
          server.close(1011, 'Timeout');
        } catch (e) { console.error('Failed to notify client of timeout:', e); }
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
    try {
      const session = this.sessions.get(ws);
      if (session) {
        // agent_confirm / agent_stop 需要绕过阻塞的 handleAgentStart 处理
        if (typeof message === 'string') {
          let msg: any;
          try { msg = JSON.parse(message); } catch { /* not JSON */ }
          if (msg && (msg.type === 'agent_confirm' || msg.type === 'agent_stop')) {
            session.handleAgentControl(msg.type, msg);
            return;
          }
        }
        await session.handleWebSocketMessage(message);
        return;
      }

      const sftpSession = this.sftpSessions.get(ws);
      if (sftpSession) {
        await sftpSession.handleSFTPWebSocketMessage(message);
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
      // Strip userId from client-supplied config (anonymous flow — userId only set via trusted token flow)
      delete config.userId;

      if (!config.host || !config.username || (!config.password && !config.privateKey)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing credentials' }));
        ws.close(1011, 'Invalid credentials');
        return;
      }

      await this.initSSHSession(ws, config);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      try {
        ws.send(JSON.stringify({ type: 'error', message: `处理消息时出错: ${errMsg}` }));
        ws.close(1011, 'Internal error');
      } catch { /* WebSocket may already be closed */ }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const session = this.sessions.get(ws);
    if (session) {
      session.close();
      this.sessions.delete(ws);
      this.deleteAttachTokensForSession(session);
    }
    const sftpSession = this.sftpSessions.get(ws);
    if (sftpSession) {
      sftpSession.detachSFTPWebSocket(ws);
      this.sftpSessions.delete(ws);
    }
    const timeout = this._pendingTimeouts.get(ws);
    if (timeout) {
      clearTimeout(timeout);
      this._pendingTimeouts.delete(ws);
    }
    this.pendingTerminalSizes.delete(ws);
    this.pendingAttachUrls.delete(ws);
    this.websocketColos.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    await this.webSocketClose(ws, 1011, 'Error', false);
  }

  private async initSSHSession(
    ws: WebSocket,
    config: SSHConnectionConfig,
    attachToken?: string
  ): Promise<void> {
    try {
      // --- SSRF Protection ---
      if (isBlockedHost(config.host)) {
        throw new Error('禁止连接内网或保留地址 (SSRF 防护)');
      }
      // DNS rebinding defence: resolve hostname and check resolved IPs
      const dnsCheck = await checkHostResolved(config.host);
      if (dnsCheck.blocked) {
        throw new Error(dnsCheck.reason!);
      }
      const BLOCKED_PORTS = [
        23, 80, 443, 25, 465, 587, 110, 143, 993, 995,
        3306, 5432, 6379, 9200, 11211, 27017, 5060,
      ];
      if (BLOCKED_PORTS.includes(config.port)) {
        throw new Error(`端口 ${config.port} 存在安全风险，已被禁止连接`);
      }

      const { connect } = await import('cloudflare:sockets');
      const hostname = config.host.includes(':') ? `[${config.host}]` : config.host;
      
      const startTime = Date.now();
      const socket = connect({ hostname, port: config.port });
      await socket.opened;
      const latency = Date.now() - startTime;

      const colo = this.websocketColos.get(ws) || 'UNKNOWN';
      this.websocketColos.delete(ws);

      const strictVerify = this.env.STRICT_HOST_KEY_VERIFY !== 'false';
      const debugMode = this.env.DEBUG_MODE === 'true';
      const pendingSize = this.pendingTerminalSizes.get(ws);
      if (pendingSize) {
        config.cols = pendingSize.cols;
        config.rows = pendingSize.rows;
      }
      const sftpAttachUrl = this.pendingAttachUrls.get(ws);
      const session = new SSHSession(ws, socket, config, strictVerify, debugMode, sftpAttachUrl, this.env, config.userId, config.githubId);
      this.sessions.set(ws, session);

      // 向前端发送双段延迟的物理基准延迟
      try {
        ws.send(JSON.stringify({ type: 'rtt', latency, colo }));
      } catch {}
      if (attachToken) {
        this.sftpAttachTokens.set(attachToken, session);
      } else if (sftpAttachUrl) {
        const token = new URL(sftpAttachUrl).searchParams.get('token');
        if (token) this.sftpAttachTokens.set(token, session);
      }
      this.pendingTerminalSizes.delete(ws);
      this.pendingAttachUrls.delete(ws);

      await session.startHandshake();

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      try {
        ws.send(JSON.stringify({ type: 'error', message: `连接失败: ${errMsg}` }));
        ws.close(1011, 'SSH connection failed');
      } catch (e) { console.error('Failed to notify client of SSH error:', e); }
    }
  }

  private rememberTerminalSize(ws: WebSocket, cols: unknown, rows: unknown): void {
    const size = normalizeTerminalSize(cols, rows);
    if (size) this.pendingTerminalSizes.set(ws, size);
  }

  private handleSFTPAttach(request: Request, url: URL): Response {
    const token = url.searchParams.get('token');
    const session = token ? this.sftpAttachTokens.get(token) : null;
    if (!session) {
      return new Response('Invalid SFTP attach token', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    this.sftpSessions.set(server, session);
    session.attachSFTPWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as any);
  }

  private buildSFTPAttachUrl(baseUrl: URL, sessionName: string, token: string): string {
    const attachUrl = new URL(baseUrl.toString());
    attachUrl.protocol = baseUrl.protocol === 'https:' || baseUrl.protocol === 'wss:' ? 'wss:' : 'ws:';
    attachUrl.pathname = '/api/ssh/sftp';
    attachUrl.search = '';
    attachUrl.searchParams.set('session', sessionName);
    attachUrl.searchParams.set('token', token);
    return attachUrl.toString();
  }

  private deleteAttachTokensForSession(session: SSHSession): void {
    for (const [token, tokenSession] of this.sftpAttachTokens) {
      if (tokenSession === session) {
        this.sftpAttachTokens.delete(token);
      }
    }
  }
}
