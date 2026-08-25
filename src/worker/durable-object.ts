import {
  type Env,
  normalizeTerminalSize,
  SESSION_GRACE_PERIOD_MS,
  type SSHConnectionConfig,
  type TerminalSize,
} from '../types';
import {
  buildResumeChallengeMessage,
  RESUME_CHALLENGE_MAX_CLOCK_SKEW_MS,
} from '../share-resume-schema';
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
  /** 认领时绑定的设备公钥（SPKI base64url）；存在时恢复必须通过挑战验签。 */
  devicePubKey?: string;
  /** 本 detached 周期内已消费的挑战 nonce，防重放；记录销毁时一并丢弃。 */
  usedNonces: Set<string>;
  /** 上一代 resume token：容忍轮换帧在弱网下丢失后的客户端重试。 */
  previousResumeToken?: string;
}

function base64UrlDecode(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function resumeReject(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  /** 分享连接握手时由 Worker 服务端链路下发的认领设备公钥（客户端不可注入）。 */
  private pendingDevicePubKeys: Map<WebSocket, string> = new Map();
  private sessionToDeviceKey: Map<SSHSession, string> = new Map();
  /** 双段延迟基线（CF→源站）：恢复时上游连接未重建，原基线仍有效可重发。 */
  private sessionBaselines: Map<SSHSession, { latencyMs: number; colo: string }> = new Map();
  /** 上一代 resume token：容忍轮换帧在弱网下丢失后的客户端重试。 */
  private sessionToPrevResumeToken: Map<SSHSession, string> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Invalid request', { status: 400 });
    }
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
        } catch {
          /* 客户端连接可能已关闭 */
        }
      }
      // 撤销必须同时覆盖断线保持期：detached 会话不在 this.sessions 中，
      // 若不在此处销毁，撤销后仍可在宽限期内凭旧凭据恢复。
      for (const [sessionId, record] of this.detachedSessions) {
        if (!record.session.belongsToShare(body.shareId)) continue;
        revoked = true;
        this.destroyDetachedRecord(sessionId, record);
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
    const sessionName =
      url.searchParams.get('session') || `session:${Date.now()}:${crypto.randomUUID()}`;

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

    const shareDeviceKey = request.headers.get('x-share-device-key');
    if (shareDeviceKey) {
      this.pendingDevicePubKeys.set(server, shareDeviceKey);
    }

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
    _reason: string,
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
      this.resumeDebug(
        `close sid=${sessionId?.slice(0, 16) ?? 'none'} code=${code} clean=${wasClean} ready=${session.isReady()} hasCreds=${Boolean(sessionId && resumeToken)}`
      );
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
          sftpAttachUrl: session.getSFTPAttachUrl(),
          devicePubKey: this.sessionToDeviceKey.get(session),
          usedNonces: new Set<string>(),
          previousResumeToken: this.sessionToPrevResumeToken.get(session),
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
        this.forgetSessionCredentials(session);
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
    this.pendingDevicePubKeys.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    await this.webSocketClose(ws, 1011, 'Error', false);
  }

  private async handleResumeRequest(
    request: Request,
    url: URL,
    sessionId: string,
    resumeToken: string
  ): Promise<Response> {
    const detached = this.detachedSessions.get(sessionId);
    if (!detached) {
      this.resumeDebug(`reject not_found sid=${sessionId.slice(0, 16)}`);
      return resumeReject(404, 'Session expired or not found');
    }

    // 容忍一代旧 token：弱网下轮换帧可能随新连接一起丢失，客户端会携带
    // 上一代 token 重试；直接锁死会造成永久 403。新旧两代均需过后续校验。
    const currentResumeToken = detached.resumeToken;
    const previousResumeToken = detached.previousResumeToken;
    const tokenIsCurrent = currentResumeToken === resumeToken;
    const tokenIsPrevious =
      !tokenIsCurrent && previousResumeToken !== undefined && previousResumeToken === resumeToken;
    if (!tokenIsCurrent && !tokenIsPrevious) {
      this.resumeDebug(`reject invalid_token sid=${sessionId.slice(0, 16)}`);
      void this.auditResumeDenied(detached, 'invalid_token');
      return resumeReject(403, 'Invalid resume token');
    }

    // 分享会话附加策略校验：绝对过期复核 + 设备绑定挑战验签。
    const policy = detached.session.getSessionPolicy();
    if (policy?.source === 'share') {
      if (Date.now() >= policy.sessionExpiresAt) {
        // 宽限期内到达分享会话绝对结束时间：立即终结，不再允许恢复。
        this.destroyDetachedRecord(sessionId, detached);
        this.resumeDebug(`reject expired sid=${sessionId.slice(0, 16)}`);
        void this.auditResumeDenied(detached, 'expired');
        return resumeReject(403, 'Share session expired');
      }
      // 严格口径：分享会话必须绑定设备公钥才允许断线恢复；
      // 未绑定（认领环境无法安全存储密钥，如无痕模式）一律拒绝。
      if (!detached.devicePubKey) {
        this.resumeDebug(`reject not_bound sid=${sessionId.slice(0, 16)}`);
        void this.auditResumeDenied(detached, 'not_bound');
        return resumeReject(403, 'Device binding required');
      }
      const verification = await this.verifyResumeDeviceSignature(detached, url);
      if (!verification.ok) {
        this.resumeDebug(`reject device:${verification.reason} sid=${sessionId.slice(0, 16)}`);
        void this.auditResumeDenied(detached, verification.reason);
        return resumeReject(403, 'Device verification failed');
      }
    }

    // 全部验证通过：轮换 resume token；被替换的一代降级为“上一代”继续容忍一次，
    // 覆盖轮换帧丢失后客户端携旧值重试的场景。
    const nextToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    this.sessionToPrevResumeToken.set(
      detached.session,
      tokenIsPrevious ? previousResumeToken : currentResumeToken
    );
    this.sessionToResumeToken.set(detached.session, nextToken);

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
    this.resumeDebug(`resume ok sid=${sessionId.slice(0, 16)} tokenRotated`);

    queueMicrotask(async () => {
      try {
        await session.reattachWebSocket(server, newSize, {
          resumeToken: nextToken,
          sftpAttachUrl: detached.sftpAttachUrl,
          baseline: this.sessionBaselines.get(session) ?? undefined,
        });
      } catch (e) {
        console.error('Failed to reattach session:', e);
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as any);
  }

  /**
   * 分享会话设备绑定验签：客户端用 claim 时绑定的非可导出私钥对
   * {sessionId, nonce, timestamp} 规范串签名；nonce 单次消费防重放。
   */
  private async verifyResumeDeviceSignature(
    detached: DetachedSessionRecord,
    url: URL
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const nonce = url.searchParams.get('did_nonce');
    const sig = url.searchParams.get('did_sig');
    const ts = Number(url.searchParams.get('did_ts'));

    if (!nonce || !/^[A-Za-z0-9]{16,128}$/.test(nonce)) {
      return { ok: false, reason: 'missing_nonce' };
    }
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > RESUME_CHALLENGE_MAX_CLOCK_SKEW_MS) {
      return { ok: false, reason: 'timestamp_skew' };
    }
    if (!sig || !/^[A-Za-z0-9_-]{64,1024}$/.test(sig)) {
      return { ok: false, reason: 'missing_signature' };
    }
    if (detached.usedNonces.has(nonce)) {
      return { ok: false, reason: 'nonce_replayed' };
    }
    // 验签前先消费 nonce：handleResumeRequest 含异步段，并发请求可能
    // 在验签间隙交错；预先占位保证同一 challenge 只能通过一次。
    detached.usedNonces.add(nonce);

    try {
      const publicKey = await crypto.subtle.importKey(
        'spki',
        base64UrlDecode(detached.devicePubKey!),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
      const message = buildResumeChallengeMessage(detached.sessionId, nonce, ts);
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        base64UrlDecode(sig),
        new TextEncoder().encode(message)
      );
      if (!valid) {
        return { ok: false, reason: 'signature_invalid' };
      }
    } catch {
      return { ok: false, reason: 'verification_error' };
    }

    return { ok: true };
  }

  /** 恢复被拒的审计事件（尽力而为；ShareDO 非活跃态会拒绝写入，静默忽略）。 */
  private auditResumeDenied(record: DetachedSessionRecord, reason: string): void {
    const policy = record.session.getSessionPolicy();
    if (policy?.source !== 'share' || !this.env.SSH_SHARE) return;
    try {
      const stub = this.env.SSH_SHARE.get(this.env.SSH_SHARE.idFromName(policy.shareRef));
      const promise = stub
        .fetch(
          new Request('http://internal/internal/audit/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              eventType: 'share.resume_denied',
              details: { reason, sessionId: record.sessionId },
            }),
          })
        )
        .then(() => undefined)
        .catch(() => undefined);
      this.state.waitUntil?.(promise);
    } catch {
      /* 审计失败不影响拒绝响应 */
    }
  }

  /** 彻底销毁一个 detached 记录：取消定时器、关闭链路并清空全部凭据映射。 */
  private destroyDetachedRecord(sessionId: string, record: DetachedSessionRecord): void {
    clearTimeout(record.graceTimeout);
    this.detachedSessions.delete(sessionId);
    for (const item of [...record.chainSessions].reverse()) {
      item.close(false);
    }
    this.deleteAttachTokensForSession(record.session);
    this.forgetSessionCredentials(record.session);
  }

  private forgetSessionCredentials(session: SSHSession): void {
    this.sessionToSessionId.delete(session);
    this.sessionToResumeToken.delete(session);
    this.sessionToPrevResumeToken.delete(session);
    this.sessionToDeviceKey.delete(session);
    this.sessionBaselines.delete(session);
  }

  /** DEBUG_MODE=true 时输出恢复链路诊断面包屑，用于定位分享会话恢复失败的具体拒绝分支。 */
  private resumeDebug(message: string): void {
    if (this.env.DEBUG_MODE === 'true') {
      console.info(`[resume-debug] ${message}`);
    }
  }

  private cleanupDetachedSession(sessionId: string): void {
    const detached = this.detachedSessions.get(sessionId);
    if (detached) {
      this.destroyDetachedRecord(sessionId, detached);
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
              params: {
                index: index + 1,
                total: jumpHosts.length,
                name: hop.name,
                host: hop.host,
                port: hop.port,
              },
            })
          );
        } catch {
          /* 通知失败不阻断跳板握手 */
        }
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
        } catch {
          /* 通知失败不阻断目标连接 */
        }
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
      const tokenSessionId = sessionName || `session:${Date.now()}:${crypto.randomUUID()}`;
      const resumeToken =
        crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      this.sessionToSessionId.set(session, tokenSessionId);
      this.sessionToResumeToken.set(session, resumeToken);
      const shareDeviceKey = this.pendingDevicePubKeys.get(ws);
      if (shareDeviceKey) {
        this.sessionToDeviceKey.set(session, shareDeviceKey);
      }

      // 严格口径：分享会话仅在成功绑定设备公钥后才支持断线恢复；
      // 未绑定（无痕等存储不可靠环境）不发放恢复凭据，前端即时终结
      const deviceBound = this.sessionToDeviceKey.has(session);
      const shareResumable = config.sessionPolicy?.source === 'share' ? deviceBound : true;

      // 记录双段延迟基线：断线重连时上游 SSH 连接未重建，原基线仍然有效
      this.sessionBaselines.set(session, { latencyMs: latency, colo });
      // 向前端发送双段延迟的物理基准延迟与 session_created 凭据
      try {
        ws.send(JSON.stringify({ type: 'rtt', latency, colo }));
        ws.send(
          JSON.stringify({
            type: 'session_created',
            sessionId: tokenSessionId,
            resumeToken: shareResumable ? resumeToken : '',
            expiresIn: 60,
            deviceBound,
            resumeEnabled: shareResumable,
          })
        );
      } catch {
        /* 凭据发送失败时由后续错误路径兜底 */
      }
      if (attachToken) {
        this.sftpAttachTokens.set(attachToken, session);
      } else if (sftpAttachUrl) {
        const token = new URL(sftpAttachUrl).searchParams.get('token');
        if (token) this.sftpAttachTokens.set(token, session);
      }
      this.pendingTerminalSizes.delete(ws);
      this.pendingAttachUrls.delete(ws);
      this.pendingDevicePubKeys.delete(ws);

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

  private handleSFTPAttach(_request: Request, url: URL): Response {
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
    let attachUrl: URL;
    try {
      attachUrl = new URL(baseUrl.toString());
    } catch {
      return baseUrl.toString();
    }
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
