import type { Env, SSHConnectionConfig } from '../types';
import {
  MCP_CONNECTION_IDLE_MS,
  MCP_OPERATION_MS,
  mcpHash,
  mcpTokenRoute,
  type McpActivity,
  type McpPrincipal,
} from '../mcp-schema';
import { checkHostResolved } from './dns-check';
import { SSHSession, type SSHSessionClient } from './ssh-session';
import { isValidTunnelHostname, TunnelWebSocketStream } from './tunnel-stream';
import { mcpDatabase } from './mcp-auth';
import { hasMcpServerScope, mcpTool } from './mcp-tools';
import { isBlockedCommand } from './agent/safety';
import { mcpList, mcpRead, mcpWrite, withMcpSftp } from './mcp-sftp';

type Connection = {
  hash: string;
  jumpIds?: number[];
  sessions: SSHSession[];
  transports: { close(): void }[];
  final?: SSHSession;
  busy: boolean;
  lastUsed: number;
  expiresAt: number;
  controller?: AbortController;
};
const BLOCKED_PORTS = [
  23, 80, 443, 25, 465, 587, 110, 143, 993, 995, 3306, 5432, 6379, 9200, 11211, 27017, 5060,
];
const silentClient: SSHSessionClient = { readyState: 1, send() {}, close() {} };
function closeConnection(connection: Connection) {
  connection.controller?.abort();
  for (const session of [...connection.sessions].reverse()) session.close(true);
  for (const transport of connection.transports) {
    try {
      transport.close();
    } catch {
      /* already closed */
    }
  }
}
function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** One token's small connection pool. MCP protocol itself has no persistent session. */
export class MCPExecutionDO {
  private connections = new Map<number, Connection>();
  private owner: string | null = null;
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const [id, connection] of this.connections) {
      if (
        connection.expiresAt <= now ||
        (!connection.busy && now - connection.lastUsed >= MCP_CONNECTION_IDLE_MS)
      ) {
        this.connections.delete(id);
        closeConnection(connection);
      }
    }
    if (this.connections.size) await this.state.storage.setAlarm(now + MCP_CONNECTION_IDLE_MS);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const invalidate = /^\/invalidate(?:\/([1-9]\d*))?$/.exec(path);
    if (request.method === 'POST' && invalidate) {
      const serverId = invalidate[1] ? Number(invalidate[1]) : null;
      for (const [id, connection] of this.connections) {
        if (serverId !== null && id !== serverId && !connection.jumpIds?.includes(serverId)) continue;
        this.connections.delete(id);
        closeConnection(connection);
      }
      if (!this.connections.size) await this.state.storage.deleteAlarm();
      return Response.json({ success: true });
    }
    if (request.method !== 'POST' || path !== '/execute') return new Response(null, { status: 404 });
    const body = await request.json<{
      token: string;
      modeTag: string;
      tool: string;
      args: Record<string, unknown>;
    }>();
    const route = mcpTokenRoute(body.token);
    if (!route) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const verified = await mcpDatabase(this.env, route, {
      action: 'verify',
      token: body.token,
      modeTag: body.modeTag,
    });
    if (!verified.ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const principal = await verified.json<McpPrincipal>();
    const owner = `${principal.routeKey}:${principal.id}`;
    if (this.owner && this.owner !== owner)
      return Response.json({ error: 'forbidden' }, { status: 403 });
    this.owner = owner;
    const spec = mcpTool(body.tool);
    const parsed = spec?.schema.safeParse(body.args);
    if (
      !spec ||
      !parsed?.success ||
      !hasMcpServerScope(principal, body.tool, Number(body.args.server_id))
    )
      return Response.json({ error: 'forbidden' }, { status: 403 });
    const args = parsed.data as Record<string, any>;
    const serverId = args.server_id as number;
    if (body.tool === 'ssh_exec' && isBlockedCommand(args.command).blocked)
      return Response.json({ error: 'command_blocked' }, { status: 403 });
    // Reserve before any await: concurrent requests never share one operation channel or create an unbounded queue.
    let connection = this.connections.get(serverId);
    if (connection?.busy || (!connection && this.connections.size >= 2))
      return Response.json({ error: 'busy' }, { status: 429 });
    if (!connection) {
      connection = {
        hash: '',
        sessions: [],
        transports: [],
        busy: false,
        lastUsed: Date.now(),
        expiresAt: principal.expiresAt,
      };
      this.connections.set(serverId, connection);
    }
    connection.busy = true;
    const current = connection;
    const controller = new AbortController();
    current.controller = controller;
    const onAbort = () => {
      for (const session of current.sessions) session.close(true);
      for (const transport of current.transports) {
        try {
          transport.close();
        } catch {
          /* closing */
        }
      }
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const onDisconnect = () => controller.abort();
    request.signal.addEventListener('abort', onDisconnect, { once: true });
    if (request.signal.aborted) controller.abort();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(MCP_OPERATION_MS, principal.expiresAt - Date.now()))
    );
    let dispatched = false;
    const activity: McpActivity = {
      id: crypto.randomUUID(),
      client: principal.name,
      serverId,
      tool: body.tool,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
    };
    const record = () =>
      mcpDatabase(this.env, route, { action: 'record', userId: principal.userId, activity }).catch(
        () => null
      );
    let failed = false;
    try {
      this.state.waitUntil(record());
      const operation = (async () => {
        const configResponse = await mcpDatabase(this.env, route, {
          action: 'config',
          token: body.token,
          modeTag: body.modeTag,
          serverId,
        });
        if (!configResponse.ok) {
          const error = await configResponse.json<{ error: string }>();
          throw new Error(
            ['host_verification_required', 'interactive_auth_required'].includes(error.error)
              ? error.error
              : 'server_unavailable'
          );
        }
        const config = await configResponse.json<SSHConnectionConfig>();
        controller.signal.throwIfAborted();
        current.jumpIds = config.jumpHosts?.map((hop) => hop.serverId);
        const hash = await mcpHash(JSON.stringify(config));
        controller.signal.throwIfAborted();
        if (current.hash !== hash || !current.final?.isOperational()) {
          for (const session of current.sessions) session.close(true);
          for (const transport of current.transports) {
            try {
              transport.close();
            } catch {
              /* closing */
            }
          }
          current.sessions = [];
          current.transports = [];
          current.final = undefined;
          current.hash = hash;
          await this.connect(current, config, controller.signal);
        }
        // Revocation/expiry may have happened during DNS, KEX or authentication.
        const check = await mcpDatabase(this.env, route, {
          action: 'verify',
          token: body.token,
          modeTag: body.modeTag,
        });
        if (!check.ok) throw new Error('unauthorized');
        const currentPrincipal = await check.json<McpPrincipal>();
        if (!hasMcpServerScope(currentPrincipal, body.tool, serverId))
          throw new Error('unauthorized');
        controller.signal.throwIfAborted();
        dispatched = true;
        if (body.tool === 'ssh_exec') {
          const command = args.cwd
            ? `cd -- ${quote(args.cwd)} || exit;\n${args.command}`
            : args.command;
          const result = await current.final!.executeCommand(
            command,
            args.timeout_ms,
            controller.signal
          );
          const cap = (value: string) =>
            value.length > 32_000
              ? `${value.slice(0, 8000)}\n[output truncated]\n${value.slice(-24_000)}`
              : value;
          return {
            stdout: cap(result.stdout),
            stderr: cap(result.stderr),
            exitCode: result.exitCode,
            truncated:
              !!result.truncated || result.stdout.length > 32_000 || result.stderr.length > 32_000,
          };
        }
        return withMcpSftp(current.final!, (sftp) => {
          if (body.tool === 'sftp_list')
            return mcpList(sftp, args.path, args.limit) as Promise<unknown>;
          if (body.tool === 'sftp_read') return mcpRead(sftp, args.path, args.offset, args.length);
          if (body.tool === 'sftp_write')
            return mcpWrite(sftp, args.path, args.content, args.expected_hash);
          throw new Error('invalid_tool');
        });
      })();
      const result = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new Error('operation_timeout'));
          else
            controller.signal.addEventListener(
              'abort',
              () => reject(new Error('operation_timeout')),
              { once: true }
            );
        }),
      ]);
      activity.status = 'success';
      return Response.json(result);
    } catch (error) {
      failed = true;
      activity.status = dispatched ? 'unknown' : 'error';
      const allowed = [
        'host_verification_required',
        'interactive_auth_required',
        'unauthorized',
        'operation_timeout',
        'expected_hash_required',
        'file_changed',
        'atomic_replace_unsupported',
        'regular_file_required',
        'special_permissions_unsupported',
        'text_files_only',
        'utf8_required',
        'text_too_large_or_binary',
      ];
      const code =
        error instanceof Error && allowed.includes(error.message)
          ? error.message
          : 'operation_failed';
      return Response.json(
        {
          error: code,
          status: dispatched ? 'unknown' : 'not_executed',
          instruction:
            'Do not automatically retry. Inspect remote state; cancellation is not rollback.',
        },
        { status: 409 }
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onDisconnect);
      current.busy = false;
      current.lastUsed = Date.now();
      if (failed || controller.signal.aborted) {
        if (this.connections.get(serverId) === current) this.connections.delete(serverId);
        closeConnection(current);
      }
      controller.signal.removeEventListener('abort', onAbort);
      current.controller = undefined;
      activity.finishedAt = Date.now();
      this.state.waitUntil(record());
      if (this.connections.size)
        await this.state.storage.setAlarm(
          Math.min(principal.expiresAt, Date.now() + MCP_CONNECTION_IDLE_MS)
        );
    }
  }
  private async connect(connection: Connection, config: SSHConnectionConfig, signal: AbortSignal) {
    const hops = config.jumpHosts ?? [];
    const tunnel = config.transportType === 'cf_tunnel';
    if (hops.length > 3 || (tunnel && hops.length)) throw new Error('invalid_route');
    if ([...hops, config].some((node) => !node.expectedFingerprint))
      throw new Error('host_verification_required');
    let transport: any;
    if (tunnel) {
      const host = config.cfTunnelHost || config.host;
      if (!isValidTunnelHostname(host) || (await checkHostResolved(host)).blocked)
        throw new Error('blocked_host');
      signal.throwIfAborted();
      const headers = new Headers({ Upgrade: 'websocket' });
      if (config.cfAccessClientId) headers.set('CF-Access-Client-Id', config.cfAccessClientId);
      if (config.cfAccessClientSecret)
        headers.set('CF-Access-Client-Secret', config.cfAccessClientSecret);
      const response = await fetch(`https://${host}/`, { headers, redirect: 'manual', signal });
      if (response.status !== 101 || !response.webSocket) throw new Error('tunnel_unavailable');
      response.webSocket.accept();
      transport = new TunnelWebSocketStream(response.webSocket, () => {});
    } else {
      const outer = hops[0] || config;
      for (const node of [...hops, config]) {
        if (
          !Number.isInteger(node.port) ||
          node.port < 1 ||
          node.port > 65535 ||
          BLOCKED_PORTS.includes(node.port)
        )
          throw new Error('blocked_port');
      }
      if ((await checkHostResolved(outer.host)).blocked) throw new Error('blocked_host');
      signal.throwIfAborted();
      const { connect } = await import('cloudflare:sockets');
      signal.throwIfAborted();
      transport = connect({
        hostname: outer.host.includes(':') ? `[${outer.host}]` : outer.host,
        port: outer.port,
      });
    }
    connection.transports.push(transport);
    if (signal.aborted) {
      transport.close();
      signal.throwIfAborted();
    }
    await transport.opened;
    for (let i = 0; i <= hops.length; i++) {
      signal.throwIfAborted();
      const node = i < hops.length ? hops[i] : { ...config, jumpHosts: undefined };
      let interactiveRequired = false;
      const client: SSHSessionClient = {
        ...silentClient,
        send(data) {
          if (typeof data !== 'string') return;
          try {
            const frame = JSON.parse(data);
            if (frame.type === 'error' && frame.event === 'auth_interactive_required')
              interactiveRequired = true;
          } catch {
            /* ignore non-control data */
          }
        },
      };
      const session = new SSHSession(
        client,
        transport,
        node,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          openShellOnAuth: false,
          ownsWebSocket: false,
          allowKeyboardInteractive: false,
          idleTimeoutMs: 120_000,
        }
      );
      connection.sessions.push(session);
      await session.startHandshake();
      try {
        await session.waitUntilAuthenticated();
      } catch (error) {
        if (interactiveRequired) throw new Error('interactive_auth_required');
        throw error;
      }
      if (i < hops.length) {
        const next = hops[i + 1] || config;
        transport = await session.openDirectTcpip(next.host, next.port);
        connection.transports.push(transport);
      } else connection.final = session;
    }
  }
}
