import { SSH_EXEC_ERROR_CODES } from './ssh/exec-error';

/** Personal automation, not a terminal takeover or an audit protocol. */
export const MCP_SCOPES = ['read', 'write', 'exec', 'context'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const MCP_MAX_TEXT_BYTES = 64 * 1024;
export const MCP_MAX_BODY_BYTES = 512 * 1024;
export const MCP_OPERATION_MS = 90_000;
export const MCP_CONNECTION_IDLE_MS = 60_000;
export const MCP_CONTEXT_TTL_MS = 30 * 60_000;
export interface McpGrant {
  serverId: number;
  scopes: McpScope[];
}
export interface McpAccessCredentials {
  clientId: string;
  clientSecret: string;
}
export interface McpConfigInfo {
  configured: boolean;
  id: string | null;
  grants: McpGrant[];
  hasAccessCredentials: boolean;
  legacy: boolean;
}
export interface McpSavedCredentials {
  token: string;
  access?: McpAccessCredentials;
}
export interface McpPrincipal {
  id: string;
  userId: number;
  routeKey: string;
  modeTag: string;
  grants: McpGrant[];
  serverIds: number[];
  scopes: McpScope[];
  name: string;
  expiresAt: number;
  createdAt: number;
}
export const MCP_FAILURE_REASONS = [
  ...SSH_EXEC_ERROR_CODES,
  'host_verification_required',
  'interactive_auth_required',
  'connection_failed',
  'operation_timeout',
  'operation_cancelled',
  'operation_failed',
] as const;
export type McpFailureReason = (typeof MCP_FAILURE_REASONS)[number];
export function isMcpFailureReason(value: unknown): value is McpFailureReason {
  return MCP_FAILURE_REASONS.includes(value as McpFailureReason);
}

export interface McpActivity {
  id: string;
  client: string;
  serverId: number;
  tool: string;
  status: 'running' | 'success' | 'failed' | 'error' | 'unknown';
  failureReason?: McpFailureReason;
  startedAt: number;
  finishedAt: number | null;
}
export function parseMcpConfigInput(value: unknown): {
  grants: McpGrant[];
  access?: McpAccessCredentials;
} {
  if (!value || typeof value !== 'object') throw new Error('invalid_arguments');
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.grants) || v.grants.length > 100) throw new Error('invalid_grants');
  const seen = new Set<number>();
  const grants = v.grants.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !Number.isSafeInteger(item.serverId) ||
      item.serverId <= 0 ||
      seen.has(item.serverId) ||
      !Array.isArray(item.scopes) ||
      !item.scopes.length ||
      item.scopes.length > 4 ||
      item.scopes.some((scope: unknown) => !MCP_SCOPES.includes(scope as McpScope))
    )
      throw new Error('invalid_grants');
    seen.add(item.serverId);
    return { serverId: item.serverId as number, scopes: [...new Set(item.scopes)] as McpScope[] };
  });
  let access: McpAccessCredentials | undefined;
  if (v.access !== undefined) {
    if (!v.access || typeof v.access !== 'object') throw new Error('invalid_access');
    const a = v.access as Record<string, unknown>;
    const valid = (s: unknown, max: number): s is string =>
      typeof s === 'string' && s.length > 0 && s.length <= max && /^[\x21-\x7e]+$/.test(s);
    if (!valid(a.clientId, 512) || !valid(a.clientSecret, 4096)) throw new Error('invalid_access');
    access = { clientId: a.clientId, clientSecret: a.clientSecret };
  }
  return { grants, ...(access ? { access } : {}) };
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
