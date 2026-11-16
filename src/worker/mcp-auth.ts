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
export async function mcpModeTag(env: Env, request?: Request): Promise<string | null> {
  const mode = resolveAuthMode(env, request);
  if (mode === 'anonymous') return null;
  if (mode === 'cf_access' && request && !hasVerifiedAccessContext(request)) return null;
  if (mode === 'password') {
    const parsed = parseAdminPasswordHash(env.ADMIN_PASSWORD_HASH);
    if (!parsed || parsed === 'invalid') return null;
    return `password:${await mcpHash(env.ADMIN_PASSWORD_HASH!)}`;
  }
  return mode;
}
export async function authenticateMcp(request: Request, env: Env) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1];
  const routeKey = token ? mcpTokenRoute(token) : null;
  const modeTag = await mcpModeTag(env, request);
  if (!token || !routeKey || !modeTag) return null;
  if (
    modeTag.startsWith('password:')
      ? routeKey !== '-1'
      : modeTag === 'cf_access'
        ? !routeKey.startsWith('cf-')
        : !/^[1-9]\d*$/.test(routeKey) || !isSshIdentityAllowed(env, routeKey)
  )
    return null;
  const response = await mcpDatabase(env, routeKey, { action: 'authorize', token, modeTag });
  if (response.status === 429)
    return Response.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
      }
    );
  if (!response.ok) return null;
  const principal = await response.json<McpPrincipal>();
  return { token, principal };
}
export function executionName(principal: Pick<McpPrincipal, 'routeKey' | 'id'>): string {
  return `mcp:${principal.routeKey}:${principal.id}`;
}
