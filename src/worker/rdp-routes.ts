import { RDP_CLIENT_REVISION, RDP_WS_PROTOCOL, isRdpId, readRdpJson } from '../rdp-schema';
import type { Env } from '../types';
import { getAuthenticatedUser, userDbRouteKey } from './auth';
import { createHtmlResponse } from './html-cache';
import { parseIdleTimeout } from './idle-timeout';
import { type RdpLease, rdpDigest, rdpJson } from './rdp-store';

export interface RdpAssets {
  page: string;
  bootstrap: string;
  socket: string;
  freerdp: string;
  wasm: ArrayBuffer;
  license: string;
  tags: readonly string[];
}

const ROOT = '/rdp/';
const API = '/api/rdp/';
const COOKIE = '__Host-cloudssh_rdp';
const securityHeaders = {
  'Cache-Control': 'private, no-store, no-transform',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
function hide() { return rdpJson({ code: 'not_found' }, 404); }
function cookie(request: Request, key: string): string {
  for (const part of request.headers.get('Cookie')?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === key) return part.slice(separator + 1).trim();
  }
  return '';
}
function binding(request: Request, browserKey: string) {
  return rdpDigest(`${browserKey}\n${cookie(request, 'session')}`);
}
function newBrowserKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function isRdpRoute(path: string): boolean {
  return path === '/rdp' || path.startsWith(ROOT) || path === '/api/rdp' || path.startsWith(API);
}

/** Handles only authenticated browser routes. Internal UserDB requests are constructed server-side. */
export async function handleRdp(
  request: Request, url: URL, env: Env, assets: RdpAssets | undefined,
  ctx?: Partial<Pick<ExecutionContext, 'waitUntil'>>,
): Promise<Response> {
  if (!assets || url.protocol !== 'https:') return hide();
  if (request.method !== 'GET' || request.headers.has('Upgrade')) {
    if (request.headers.get('Origin') !== url.origin) return rdpJson({ code: 'forbidden' }, 403);
  }

  const user = await getAuthenticatedUser(request, env);
  if (!user) return rdpJson({ code: 'authentication_required' }, 401);
  const routeKey = await userDbRouteKey(user);
  const db = env.USER_DB.get(env.USER_DB.idFromName(routeKey));
  function call(path: string, method = 'GET', data?: unknown) {
    return db.fetch(new Request(`https://internal/internal/rdp/${path}?user_id=${user?.id}`, {
      method,
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    }));
  }
  const path = url.pathname;
  if (path === API + 'session' && request.method === 'GET') {
    if (url.search || request.headers.get('Origin') !== url.origin || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || request.headers.get('Sec-WebSocket-Protocol') !== RDP_WS_PROTOCOL) return hide();
    const browserKey = cookie(request, COOKIE);
    if (!/^[a-f0-9]{64}$/.test(browserKey)) return hide();
    const digest = await binding(request, browserKey);
    const { startRdpRelay } = await import('./rdp-relay');
    return startRdpRelay({
      idleMs: parseIdleTimeout(env.IDLE_TIMEOUT),
      waitUntil: typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : undefined,
      async claim(ticket) {
        const response = await call('claim', 'POST', { ticket, binding: digest });
        return response.ok ? response.json<RdpLease>() : null;
      },
      async renew(lease) {
        const current = await getAuthenticatedUser(request, env);
        if (!current || current.id !== user?.id || await userDbRouteKey(current) !== routeKey) return false;
        return (await call('renew', 'POST', { lease })).ok;
      },
      async desktopReady(lease) { return (await call('desktop-ready', 'POST', { lease })).ok; },
      async release(lease) { await call('release', 'POST', { lease }); },
    });
  }
  if (path.startsWith(API) && !url.search) {
    const resource = path.slice(API.length);
    if (resource === 'profiles') {
      if (request.method === 'GET') return call('profiles');
      if (request.method === 'POST') return call('profiles', 'POST', await readRdpJson(request));
    }
    const match = /^profiles\/([a-f0-9-]{36})(\/(?:connect|trust|login-identity))?$/.exec(resource);
    if (!match || !isRdpId(match[1])) return hide();
    const [, id, action] = match;
    if (action === '/login-identity' && request.method === 'POST') {
      if (request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CLIENT_REVISION)) return rdpJson({ code: 'refresh_client' }, 409);
      return call(`profiles/${id}/login-identity`, 'POST', await readRdpJson(request));
    }
    if (action === '/trust' && request.method === 'PUT') {
      if (request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CLIENT_REVISION)) return rdpJson({ code: 'refresh_client' }, 409);
      return call(`profiles/${id}/trust`, 'PUT', await readRdpJson(request));
    }
    if (action === '/connect' && request.method === 'POST') {
      let key = cookie(request, COOKIE);
      const issueCookie = !/^[a-f0-9]{64}$/.test(key);
      if (issueCookie) key = newBrowserKey();
      if (request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CLIENT_REVISION)) {
        return rdpJson({ code: 'refresh_client' }, 409);
      }
      const savedRevision = request.headers.get('X-CloudSSH-RDP-Saved-Revision');
      if (!savedRevision || !/^[1-9]\d{0,9}$/.test(savedRevision)) return rdpJson({ code: 'invalid_revision' }, 400);
      const response = await call('ticket', 'POST', { profile: id, binding: await binding(request, key),
        savedRevision: Number(savedRevision) });
      if (!response.ok || !issueCookie) return response;
      const headers = new Headers(response.headers);
      headers.append('Set-Cookie', `${COOKIE}=${key}; Path=/; Secure; HttpOnly; SameSite=Strict`);
      return new Response(response.body, { status: response.status, headers });
    }
    if (!action && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
      return call(`profiles/${id}`, request.method, request.method === 'PUT' ? await readRdpJson(request) : undefined);
    }
    return hide();
  }
  if (!path.startsWith(ROOT) || request.method !== 'GET' || url.search) return hide();
  const resource = path.slice(ROOT.length);
  const embedded = resource.endsWith('/client');
  const deviceId = embedded ? resource.slice(0, -7) : resource;
  if (isRdpId(deviceId)) {
    const profile = await call(`profiles/${deviceId}`);
    if (!profile.ok) return hide();
    void profile.body?.cancel().catch(() => {});
    if (embedded) {
      return new Response(assets.page, { headers: { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': securityHeaders['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'") } });
    }
    // Only the RDP workspace needs isolation. Ordinary login (including Turnstile) stays unchanged.
    const shell = createHtmlResponse(request);
    shell.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    shell.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    shell.headers.set('Cache-Control', 'private, no-store, no-transform');
    return shell;
  }
  const resources = new Map<string, [string | ArrayBuffer, string, string?]>([
    ['assets/desktop.js', [assets.bootstrap, 'text/javascript; charset=utf-8']],
    ['assets/rdp-socket.js', [assets.socket, 'text/javascript; charset=utf-8']],
    ['assets/sdl-freerdp.js', [assets.freerdp, 'text/javascript; charset=utf-8', assets.tags[0]]],
    ['assets/sdl-freerdp.wasm', [assets.wasm, 'application/wasm', assets.tags[1]]],
    ['assets/licenses.txt', [assets.license, 'text/plain; charset=utf-8']],
  ]);
  const entry = resources.get(resource);
  if (!entry) return hide();
  const [data, mime, tag] = entry;
  const headers = new Headers({ ...securityHeaders, 'Content-Type': mime });
  if (mime === 'application/wasm') headers.set('Vary', 'Accept-Encoding');
  if (tag) {
    const value = `W/"${tag}"`;
    headers.set('ETag', value);
    headers.set('Cache-Control', 'private, no-cache, no-transform');
    if (request.headers.get('If-None-Match') === value) return new Response(null, { status: 304, headers });
  }
  if (mime !== 'application/wasm') return new Response(data, { headers });
  const supported = request.headers.get('Accept-Encoding')?.split(',').some(value => {
    const match = /^gzip\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(value.trim());
    return !!match && (match[1] === undefined || Number(match[1]) > 0);
  });
  if (supported) {
    headers.set('Content-Encoding', 'gzip');
    return new Response(data, { headers, encodeBody: 'manual' });
  }
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')), { headers });
}
