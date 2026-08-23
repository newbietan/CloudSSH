import {
  type Env,
  normalizeTerminalSize,
  SESSION_GRACE_PERIOD_MS,
  type SSHConnectionConfig,
  type TerminalSize,
} from '../types';
import { checkHostResolved } from './dns-check';
import { SSHSession } from './ssh-session';

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

interface DetachedSessionRecord {
  sessionId: string;
  resumeToken: string;
  session: SSHSession;
  chainSessions: SSHSession[];
  detachedAt: number;
  graceTimeout: ReturnType<typeof setTimeout>;
  sftpAttachUrl?: string;
}

export class SSHSessionDO {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<WebSocket, SSHSession> = new Map();
  private sessionChains: Map<WebSocket, SSHSession[]> = new Map();
  private sftpSessions: Map<WebSocket, SSHSession> = new Map();
  private sftpAttachTokens: Map<string, SSHSession> = new Map();
  private _pendingTimeouts: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();
  private pendingTerminalSizes: Map<WebSocket, TerminalSize> = new Map();
  private pendingAttachUrls: Map<WebSocket, string> = new Map();
  private websocketColos: Map<WebSocket, string> = new Map();
  private pendingSessionNames: Map<WebSocket, string> = new Map();
  private detachedSessions: Map<string, DetachedSessionRecord> = new Map();
  private sessionToSessionId: Map<SSHSession, string> = new Map();
  private sessionToResumeToken: Map<SSHSession, string> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/internal/revoke-share' && request.method === 'POST') {
      const body = await request.json<{ shareId?: string }>();
      if (!body.shareId) return new Response('Invalid share', { status: 400 });
      let revoked = false;
      for (const [ws, session] of this.sessions) {
        if (!session.belongsToShare(body.shareId)) continue;
        revoked = true;
        session.close(true);
        try {
          ws.close(1000, 'Shared session revoked');
        } catch {}
      }
      return Response.json({ success: true, revoked });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    if (url.pathname === '/api/ssh/sftp') {
      return this.handleSFTPAttach(request, url);
    }

    // 处理会话断线秒级重连 (Re-attach)
    const resumeToken = url.searchParams.get('resume_token');
    const resumeSessionId = url.searchParams.get('session');
    if (resumeToken && resumeSessionId) {
      return this.handleResumeRequest(request, url, resumeSessionId, resumeToken);
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
    this.pendingSessionNames.set(server, sessionName);

    this.state.acceptWebSocket(server);
    const attachToken = crypto.randomUUID();
    const sftpAttachUrl = this.buildSFTPAttachUrl(url, sessionName, attachToken);
    this.pendingAttachUrls.set(server, sftpAttachUrl);

    if (prefilledConfig) {
      server.serializeAttachment({ state: 'prefilled' });
      queueMicrotask(async () => {
        try {
          await this.initSSHSession(server, prefilledConfig!, attachToken, sessionName);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          try {
            server.send(JSON.stringify({ type: 'error', message: `连接失败: ${errMsg}` }));
            server.close(1011, 'SSH connection failed');
          } catch (e) {
            console.error('Failed to notify client of connection error:', e);
          }
        }
      });
    } else {
      const timeout = setTimeout(() => {
        try {
          server.send(JSON.stringify({ type: 'error', message: 'Connection timeout' }));
          server.close(1011, 'Timeout');
        } catch (e) {
          console.error('Failed to notify client of timeout:', e);
        }
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
          try {
            msg = JSON.parse(message);
          } catch {
            /* not JSON */
          }
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
        const id = typeof msg.id === 'string' && msg.id.length <= 128 ? msg.id : undefined;
        ws.send(JSON.stringify({ type: 'pong', ...(id ? { id } : {}) }));
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
      // Jump chains are resolved only from authenticated saved-server tokens.
      delete config.jumpHosts;
      delete config.knownHostIdentity;
      delete config.sessionPolicy;

      if (!config.host || !config.username || (!config.password && !config.privateKey)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing credentials' }));
        ws.close(1011, 'Invalid credentials');
        return;
      }

      const pendingSessionName = this.pendingSessionNames.get(ws);
      await this.initSSHSession(ws, config, undefined, pendingSessionName);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      try {
        ws.send(JSON.stringify({ type: 'error', message: `处理消息时出错: ${errMsg}` }));
        ws.close(1011, 'Internal error');
      } catch {
        /* WebSocket may already be closed */
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    const session = this.sessions.get(ws);
    if (session) {
      const chain = this.sessionChains.get(ws) || [session];
      const sessionId = this.sessionToSessionId.get(session);
      const resumeToken = this.sessionToResumeToken.get(session);

      this.sessions.delete(ws);
      this.sessionChains.delete(ws);

      // 仅当异常断线（code !== 1000 且 wasClean !== true）、会话处于就绪状态、且具备凭据时开启 60s 保持
      if (code !== 1000 && !wasClean && session.isReady() && sessionId && resumeToken) {
        session.setDetached(true);

        const graceTimeout = setTimeout(() => {
          this.cleanupDetachedSession(sessionId);
        }, SESSION_GRACE_PERIOD_MS);

        this.detachedSessions.set(sessionId, {
          sessionId,
          resumeToken,
          session,
          chainSessions: chain,
          detachedAt: Date.now(),
          graceTimeout,
        });

        // 保持后台受保护
        if (this.state.waitUntil) {
          this.state.waitUntil(
            new Promise<void>((resolve) => {
              setTimeout(resolve, SESSION_GRACE_PERIOD_MS + 1000);
            })
          );
        }
      } else {
        // 主动退出（1000）或未就绪断开：立即完全销毁
        for (const item of [...chain].reverse()) item.close(code === 1000);
        this.deleteAttachTokensForSession(session);
        if (sessionId) {
          this.cleanupDetachedSession(sessionId);
        }
      }
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
    this.pendingSessionNames.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    await this.webSocketClose(ws, 1011, 'Error', false);
  }

  private handleResumeRequest(
    request: Request,
    url: URL,
    sessionId: string,
    resumeToken: string
  ): Response {
    const detached = this.detachedSessions.get(sessionId);
    if (!detached) {
      return new Response(JSON.stringify({ error: 'Session expired or not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (detached.resumeToken !== resumeToken) {
      return new Response(JSON.stringify({ error: 'Invalid resume token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 取消销毁定时器
    clearTimeout(detached.graceTimeout);
    this.detachedSessions.delete(sessionId);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const colo = request.headers.get('x-cloudflare-colo') || 'UNKNOWN';
    this.websocketColos.set(server, colo);

    this.state.acceptWebSocket(server);

    const cols = url.searchParams.get('cols') ? Number(url.searchParams.get('cols')) : undefined;
    const rows = url.searchParams.get('rows') ? Number(url.searchParams.get('rows')) : undefined;
    const newSize = normalizeTerminalSize(cols, rows) || undefined;

    const session = detached.session;
    this.sessions.set(server, session);
    this.sessionChains.set(server, detached.chainSessions);

    queueMicrotask(async () => {
      try {
        await session.reattachWebSocket(server, newSize);
      } catch (e) {
        console.error('Failed to reattach session:', e);
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as any);
  }

  private cleanupDetachedSession(sessionId: string): void {
    const detached = this.detachedSessions.get(sessionId);
    if (detached) {
      clearTimeout(detached.graceTimeout);
      this.detachedSessions.delete(sessionId);
      for (const item of [...detached.chainSessions].reverse()) {
        item.close(false);
      }
      this.deleteAttachTokensForSession(detached.session);
    }
  }

  private async initSSHSession(
    ws: WebSocket,
    config: SSHConnectionConfig,
    attachToken?: string,
    sessionName?: string
  ): Promise<void> {
    const chainSessions: SSHSession[] = [];
    try {
      const jumpHosts = config.jumpHosts || [];
      if (jumpHosts.length > 3) throw new Error('最多允许 3 级 SSH 跳转');
      const outer = jumpHosts[0] || config;
      if (!Number.isInteger(outer.port) || outer.port < 1 || outer.port > 65535) {
        throw new Error('端口必须是 1-65535 之间的整数');
      }
      // SSRF checks apply to the only address reached directly from Cloudflare.
      // Private destinations are allowed only inside a trusted saved-server chain.
      if (isBlockedHost(outer.host)) {
        throw new Error('禁止连接内网或保留地址 (SSRF 防护)');
      }
      const dnsCheck = await checkHostResolved(outer.host);
      if (dnsCheck.blocked) {
        throw new Error(dnsCheck.reason!);
      }
      const BLOCKED_PORTS = [
        23, 80, 443, 25, 465, 587, 110, 143, 993, 995, 3306, 5432, 6379, 9200, 11211, 27017, 5060,
      ];
      for (const node of [...jumpHosts, config]) {
        if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
          throw new Error('端口必须是 1-65535 之间的整数');
        }
        if (BLOCKED_PORTS.includes(node.port)) {
          throw new Error(`端口 ${node.port} 存在安全风险，已被禁止连接`);
        }
      }

      const { connect } = await import('cloudflare:sockets');
      const hostname = outer.host.includes(':') ? `[${outer.host}]` : outer.host;

      const startTime = Date.now();
      let transport: any = connect({ hostname, port: outer.port });
      await transport.opened;
      const latency = Date.now() - startTime;

      const colo = this.websocketColos.get(ws) || 'UNKNOWN';
      this.websocketColos.delete(ws);

      // Capability links never inherit the ordinary-session escape hatch: every
      // hop must prove possession of its already trusted host key.
      const strictVerify =
        config.sessionPolicy?.source === 'share'
          ? true
          : this.env.STRICT_HOST_KEY_VERIFY !== 'false';
      const debugMode = this.env.DEBUG_MODE === 'true';
      const pendingSize = this.pendingTerminalSizes.get(ws);
      if (pendingSize) {
        config.cols = pendingSize.cols;
        config.rows = pendingSize.rows;
      }
      const sftpAttachUrl = this.pendingAttachUrls.get(ws);

      for (let index = 0; index < jumpHosts.length; index++) {
        const hop = jumpHosts[index];
        try {
          ws.send(
            JSON.stringify({
              type: 'status',
              event: 'jump_hop_connecting',
              message: `正在连接跳板服务器 ${hop.name}`,
              params: { host: hop.host, port: hop.port, name: hop.name },
            })
          );
        } catch {}
        const hopSession = new SSHSession(
          ws,
          transport,
          { ...hop, sessionPolicy: undefined },
          strictVerify,
          debugMode,
          undefined,
          this.env,
          config.userId,
          config.githubId,
          {
            openShellOnAuth: false,
            ownsWebSocket: false,
            allowKeyboardInteractive: false,
            waitUntil: (promise) => this.state.waitUntil(promise),
          }
        );
        chainSessions.push(hopSession);
        this.sessionChains.set(ws, chainSessions);
        await hopSession.startHandshake();

        const destination = jumpHosts[index + 1] || config;
        transport = await hopSession.openDirectTcpip(destination.host, destination.port);
      }

      const finalConfig = { ...config, jumpHosts: undefined };
      if (jumpHosts.length > 0) {
        try {
          ws.send(
            JSON.stringify({
              type: 'status',
              event: 'jump_target_connecting',
              message: `正在通过跳板连接目标服务器 ${config.host}:${config.port}`,
              params: { host: config.host, port: config.port },
            })
          );
        } catch {}
      }
      const session = new SSHSession(
        ws,
        transport,
        finalConfig,
        strictVerify,
        debugMode,
        sftpAttachUrl,
        this.env,
        config.userId,
        config.githubId,
        { waitUntil: (promise) => this.state.waitUntil(promise) }
      );
      chainSessions.push(session);
      this.sessionChains.set(ws, chainSessions);
      this.sessions.set(ws, session);

      // 生成 256 位加密随机 Token 并下发会话凭据
      const tokenSessionId = sessionName || `session:${Date.now()}:${Math.random()}`;
      const resumeToken =
        crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      this.sessionToSessionId.set(session, tokenSessionId);
      this.sessionToResumeToken.set(session, resumeToken);

      // 向前端发送双段延迟的物理基准延迟与 session_created 凭据
      try {
        ws.send(JSON.stringify({ type: 'rtt', latency, colo }));
        ws.send(
          JSON.stringify({
            type: 'session_created',
            sessionId: tokenSessionId,
            resumeToken,
            expiresIn: 60,
          })
        );
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
      for (const session of [...chainSessions].reverse()) session.close();
      this.sessionChains.delete(ws);
      this.sessions.delete(ws);
      const errMsg = error instanceof Error ? error.message : String(error);
      const normalClose =
        typeof error === 'object' &&
        error !== null &&
        (error as { normalClose?: unknown }).normalClose === true;
      try {
        if (!normalClose)
          ws.send(JSON.stringify({ type: 'error', message: `连接失败: ${errMsg}` }));
        ws.close(
          normalClose ? 1000 : 1011,
          normalClose ? 'SSH authentication ended' : 'SSH connection failed'
        );
      } catch (e) {
        console.error('Failed to notify client of SSH error:', e);
      }
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
    attachUrl.protocol =
      baseUrl.protocol === 'https:' || baseUrl.protocol === 'wss:' ? 'wss:' : 'ws:';
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
