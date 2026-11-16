import type { ZodRawShape } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { readMcpJson, type McpPrincipal } from '../mcp-schema';
import type { Env } from '../types';
import { getAuthenticatedUser, userDbRouteKey } from './auth';
import { authenticateMcp, executionName, mcpDatabase, mcpModeTag } from './mcp-auth';
import { MCP_TOOLS, hasMcpScope, hasMcpServerScope } from './mcp-tools';

const contextPattern = /^session:\d{10,16}:[0-9a-f-]{36}$/;
function jsonError(error: string, status: number) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function contextRequest(env: Env, session: string, body: Record<string, unknown>) {
  return env.SSH_SESSION.get(env.SSH_SESSION.idFromName(session)).fetch(
    new Request('https://internal/internal/mcp-context', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}
export async function handleMcpManagement(request: Request, env: Env): Promise<Response> {
  if (!env.MCP_EXECUTION) return jsonError('mcp_unavailable', 503);
  const user = await getAuthenticatedUser(request, env);
  if (!user) return jsonError('unauthorized', 401);
  const routeKey = await userDbRouteKey(user);
  const modeTag = await mcpModeTag(env, request);
  if (!modeTag) return jsonError('unauthorized', 401);
  const path = new URL(request.url).pathname;
  const base = { userId: user.id, routeKey, modeTag };
  if (path === '/api/mcp/config' && request.method === 'GET')
    return mcpDatabase(env, routeKey, { ...base, action: 'settings' });
  if (path === '/api/mcp/config/credentials' && request.method === 'POST')
    return mcpDatabase(env, routeKey, { ...base, action: 'credentials' });
  if (path === '/api/mcp/config' && ['POST', 'PUT'].includes(request.method)) {
    const result = await mcpDatabase(env, routeKey, {
      ...base,
      action: request.method === 'POST' ? 'create' : 'update',
      input: await readMcpJson(request),
    });
    if (result.ok && request.method === 'PUT') {
      const info = await result.clone().json<{ id: string }>();
      // Save is authoritative; stop old operations/pools best effort after permission changes.
      try {
        await env.MCP_EXECUTION.get(
          env.MCP_EXECUTION.idFromName(executionName({ routeKey, id: info.id }))
        ).fetch(new Request('https://internal/invalidate', { method: 'POST' }));
      } catch {
        /* next requests recheck the stored grants */
      }
    }
    return result;
  }
  if (path === '/api/mcp/activity' && request.method === 'GET')
    return mcpDatabase(env, routeKey, { ...base, action: 'activity' });
  if (path === '/api/mcp/context' && request.method === 'POST') {
    const input = (await readMcpJson(request)) as Record<string, unknown>;
    if (
      !input ||
      !contextPattern.test(String(input.session)) ||
      (typeof input.enabled !== 'boolean' && input.inspect !== true) ||
      !Number.isSafeInteger(input.serverId) ||
      Number(input.serverId) < 1
    )
      return jsonError('invalid_arguments', 400);
    return contextRequest(env, String(input.session), {
      ...base,
      serverId: input.serverId,
      enabled: input.enabled,
      inspect: input.inspect === true,
    });
  }
  return jsonError('not_found', 404);
}
async function executeTool(
  env: Env,
  token: string,
  principal: McpPrincipal,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
) {
  if (!hasMcpScope(principal.scopes, name)) return jsonError('forbidden', 403);
  if (name === 'server_list')
    return mcpDatabase(env, principal.routeKey, {
      action: 'servers',
      token,
      modeTag: principal.modeTag,
    });
  if (!hasMcpServerScope(principal, name, Number(args.server_id)))
    return jsonError('forbidden', 403);
  if (name === 'session_output') {
    const checked = await mcpDatabase(env, principal.routeKey, {
      action: 'verify',
      token,
      modeTag: principal.modeTag,
    });
    if (
      !checked.ok ||
      !hasMcpServerScope(await checked.json<McpPrincipal>(), name, Number(args.server_id))
    )
      return jsonError('forbidden', 403);
    // Snapshot reads do not connect, create an execution session, or refresh user activity.
    return contextRequest(env, String(args.context_id), {
      userId: principal.userId,
      routeKey: principal.routeKey,
      serverId: args.server_id,
      lastLines: args.last_lines,
    });
  }
  return env.MCP_EXECUTION!.get(env.MCP_EXECUTION!.idFromName(executionName(principal))).fetch(
    new Request('https://internal/execute', {
      method: 'POST',
      signal,
      body: JSON.stringify({ token, modeTag: principal.modeTag, tool: name, args }),
    })
  );
}
/** Stateless Streamable HTTP; no browser-cookie fallback and no long-lived GET stream. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) return jsonError('forbidden', 403);
  if (!env.MCP_EXECUTION) return jsonError('mcp_unavailable', 503);
  const auth = await authenticateMcp(request, env);
  if (auth instanceof Response) return auth;
  if (!auth)
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer realm="CloudSSH MCP"',
      },
    });
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let parsedBody: unknown;
  try {
    parsedBody = await readMcpJson(request);
  } catch {
    return jsonError('invalid_request', 400);
  }
  const server = new McpServer({ name: 'CloudSSH', version: '1.0.0' });
  for (const spec of MCP_TOOLS) {
    if (!hasMcpScope(auth.principal.scopes, spec.name)) continue;
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.schema.shape as ZodRawShape,
        annotations: {
          readOnlyHint: spec.scope !== 'write' && spec.scope !== 'exec',
          destructiveHint: spec.scope === 'write' || spec.scope === 'exec',
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args, extra): Promise<CallToolResult> => {
        // Revalidate even after protocol parsing; a schema/annotation is not authorization.
        const parsed = spec.schema.safeParse(args);
        if (!parsed.success)
          return { isError: true, content: [{ type: 'text', text: 'invalid_arguments' }] };
        try {
          const response = await executeTool(
            env,
            auth.token,
            auth.principal,
            spec.name,
            parsed.data,
            AbortSignal.any([request.signal, extra.signal])
          );
          const result = await response.json();
          return {
            isError: !response.ok,
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'operation_unavailable',
                  status: 'unknown',
                  instruction: 'Inspect remote state before retrying. No automatic replay.',
                }),
              },
            ],
          };
        }
      }
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    // JSON responses are materialized before closing the per-request SDK transport.
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.status === 202 || response.status === 204 ? null : body, {
      status: response.status,
      headers,
    });
  } finally {
    await server.close();
  }
}
