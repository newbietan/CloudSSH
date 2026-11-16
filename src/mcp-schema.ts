/** Personal automation, not a terminal takeover or an audit protocol. */
export const MCP_SCOPES = ['read', 'write', 'exec', 'context'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const MCP_MAX_TEXT_BYTES = 64 * 1024;
export const MCP_MAX_BODY_BYTES = 512 * 1024;
export const MCP_OPERATION_MS = 90_000;
export const MCP_CONNECTION_IDLE_MS = 60_000;
export const MCP_CONTEXT_TTL_MS = 30 * 60_000;
export interface McpTokenInfo {
  id: string;
  name: string;
  serverIds: number[];
  scopes: McpScope[];
  expiresAt: number;
  createdAt: number;
}
export interface McpPrincipal extends McpTokenInfo {
  userId: number;
  routeKey: string;
  modeTag: string;
}
export interface McpActivity {
  id: string;
  client: string;
  serverId: number;
  tool: string;
  status: 'running' | 'success' | 'error' | 'unknown';
  startedAt: number;
  finishedAt: number | null;
}
export function parseMcpTokenInput(value: unknown): {
  name: string;
  serverIds: number[];
  scopes: McpScope[];
  days: number;
} {
  if (!value || typeof value !== 'object') throw new Error('invalid_arguments');
  const v = value as Record<string, unknown>;
  if (
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    v.name.trim().length > 50 ||
    !Array.isArray(v.serverIds) ||
    !v.serverIds.length ||
    v.serverIds.length > 100 ||
    v.serverIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    !Array.isArray(v.scopes) ||
    !v.scopes.length ||
    v.scopes.some((s) => !MCP_SCOPES.includes(s as McpScope)) ||
    !Number.isInteger(v.days) ||
    (v.days as number) < 1 ||
    (v.days as number) > 365
  ) {
    throw new Error('invalid_arguments');
  }
  return {
    name: v.name.trim(),
    serverIds: [...new Set(v.serverIds)],
    scopes: [...new Set(v.scopes)] as McpScope[],
    days: v.days as number,
  };
}
export function mcpTokenRoute(token: string): string | null {
  return /^mcp_(-1|[1-9]\d{0,19}|cf-[0-9a-f]{32}):[0-9a-f]{64}$/.exec(token)?.[1] ?? null;
}
export async function mcpHash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export async function readMcpJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > MCP_MAX_BODY_BYTES)
    throw new Error('body_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_arguments');
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 10_000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_MAX_BODY_BYTES) throw new Error('body_too_large');
      chunks.push(value);
    }
    if (timedOut) throw new Error('body_timeout');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } finally {
    clearTimeout(deadline);
    void reader.cancel().catch(() => {});
  }
}
