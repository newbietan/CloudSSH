import { mcpHash, mcpTokenRoute, type McpPrincipal } from '../mcp-schema';
import type { Env } from '../types';
import {
  hasVerifiedAccessContext,
  isSshIdentityAllowed,
  parseAdminPasswordHash,
  resolveAuthMode,
} from './auth';

export function mcpDatabase(
  env: Env,
  routeKey: string,
  body: Record<string, unknown>
): Promise<Response> {
  return env.USER_DB.get(env.USER_DB.idFromName(routeKey)).fetch(
    new Request('https://internal/internal/mcp', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}
export async function mcpModeTag(env: Env, request: Request): Promise<string | null> {
  const mode = resolveAuthMode(env, request);
  if (mode === 'anonymous') return null;
  if (mode === 'cf_access' && !hasVerifiedAccessContext(request)) return null;
  if (mode === 'password') {
    const parsed = parseAdminPasswordHash(env.ADMIN_PASSWORD_HASH);
    if (!parsed || parsed === 'invalid') return null;
    return `password:${await mcpHash(env.ADMIN_PASSWORD_HASH!)}`;
  }
  return mode;
}
type McpAuthDenial =
  | 'invalid_bearer'
  | 'access_context_missing'
  | 'auth_mode_unavailable'
  | 'account_mode_mismatch'
  | 'credential_rejected'
  | 'credential_lookup_failed';
let diagnosticWindowStart = 0;
let diagnosticCount = 0;
/** Only fixed reason codes, never headers, tokens, identities or upstream error bodies. */
function denied(env: Env, reason: McpAuthDenial): null {
  if (env.DEBUG_MODE === 'true') {
    const now = Date.now();
    if (now < diagnosticWindowStart || now - diagnosticWindowStart >= 60_000) {
      diagnosticWindowStart = now;
      diagnosticCount = 0;
    }
    // Invalid requests do not reach the account limiter. Bound debug logs per isolate too.
    if (diagnosticCount < 20) {
      diagnosticCount++;
      console.warn('mcp.auth.denied', { reason });
    }
  }
  return null;
}
export async function authenticateMcp(request: Request, env: Env) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1];
  const routeKey = token ? mcpTokenRoute(token) : null;
  if (!token || !routeKey) return denied(env, 'invalid_bearer');
  const modeTag = await mcpModeTag(env, request);
  if (!modeTag) {
    return denied(
      env,
      resolveAuthMode(env, request) === 'cf_access' && !hasVerifiedAccessContext(request)
        ? 'access_context_missing'
        : 'auth_mode_unavailable'
    );
  }
  if (
    modeTag.startsWith('password:')
      ? routeKey !== '-1'
      : modeTag === 'cf_access'
        ? !routeKey.startsWith('cf-')
        : !/^[1-9]\d*$/.test(routeKey) || !isSshIdentityAllowed(env, routeKey)
  )
    return denied(env, 'account_mode_mismatch');
  const response = await mcpDatabase(env, routeKey, { action: 'authorize', token, modeTag });
  if (response.status === 429)
    return Response.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
      }
    );
  if (!response.ok)
    return denied(
      env,
      response.status >= 500 || response.status === 404
        ? 'credential_lookup_failed'
        : 'credential_rejected'
    );
  const principal = await response.json<McpPrincipal>();
  return { token, principal };
}
export function executionName(principal: Pick<McpPrincipal, 'routeKey' | 'id'>): string {
  return `mcp:${principal.routeKey}:${principal.id}`;
}
