import { RDP_CLIENT_REVISION, RDP_CONNECT_KEY_HEADER, RDP_CONNECT_REVISION, RDP_WS_PROTOCOL, isRdpId, readRdpJson, rdpConnectorSetupFilename, type RdpProfile } from '../rdp-schema';
import type { Env } from '../types';
import { getAuthenticatedUser, hasVerifiedAccessContext, resolveAuthMode, userDbRouteKey } from './auth';
import { createHtmlResponse } from './html-cache';
import { parseIdleTimeout } from './idle-timeout';
import { type RdpLease, rdpDigest, rdpJson } from './rdp-store';
import { deviceMachinePath, digestHex, ENROLL_MS, PEER_PROTOCOL, isDeviceSignature, randomProof, registrationMessage,
  signDeviceScope, STANDBY_PROTOCOL, verifyDeviceScope, verifyDeviceSignature } from './rdp-device-auth';
import { validRegistration } from './rdp-devices';
import { downloadRdpConnector } from './rdp-connector-download';
import { inspectRdpConnectorArchive, personalRdpConnectorArchive } from './rdp-connector-archive';
import { isRdpConnectKey, parseRdpConnectGrant } from './rdp-connect-crypto';

export interface RdpAssets {
  page: string;
  bootstrap: string;
  socket: string;
  peer?: string;
  connectorPreview?: ArrayBuffer;
  freerdp: string;
  wasm: ArrayBuffer;
  license: string;
  tags: readonly string[];
}

const ROOT = '/rdp/';
const API = '/api/rdp/';
const COOKIE = '__Host-cloudssh_rdp';
const ticketErrors = new Set(['invalid_request', 'not_found', 'profile_changed', 'login_unavailable', 'peer_unavailable', 'ticket_limit']);
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

async function handleDeviceMachine(request: Request, url: URL, env: Env, action: string): Promise<Response> {
  if (!env.RDP_AUTHORITY || url.search) return hide();
  const socket = action === 'standby' || action === 'attach';
  const protocol = action === 'standby' ? STANDBY_PROTOCOL : PEER_PROTOCOL;
  if (socket ? (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
      request.headers.get('Sec-WebSocket-Protocol') !== protocol) : (request.method !== 'POST' || request.headers.has('Upgrade'))) return hide();
  if (action === 'register') {
    const cap = await verifyDeviceScope(env, request, 'e3');
    if (!cap) return rdpJson({ code: 'connector_unavailable' }, 401);
    const data = await readRdpJson(request) as Record<string, unknown> | null;
    if (!data || !validRegistration(data) ||
        !await verifyDeviceSignature(data.key, data.signature, registrationMessage(cap.token, data.key, data.label))) {
      return rdpJson({ code: 'connector_unavailable' }, 401);
    }
    const db = env.USER_DB.get(env.USER_DB.idFromName(cap.route));
    const result = await db.fetch(`https://internal/internal/rdp/device-register?user_id=${cap.uid}`, {
      method: 'POST', headers: { 'X-RDP-Origin': url.origin },
      body: JSON.stringify({ profile: cap.profile, proof: await rdpDigest(cap.proof), key: data.key, label: data.label }),
    });
    if (!result.ok) return result;
    const { device, fingerprint } = await result.json<{ device: string; fingerprint: string }>();
    const identity = await signDeviceScope(env, request, 'd2', { route: cap.route, uid: cap.uid, profile: cap.profile, device });
    return rdpJson({ identity, fingerprint });
  }
  const cap = await verifyDeviceScope(env, request, 'd2');
  if (!cap) return rdpJson({ code: 'connector_unavailable' }, 401);
  const proof = request.headers.get('X-RDP-Device-Proof');
  const signature = request.headers.get('X-RDP-Device-Signature');
  if (socket && (!digestHex(proof) || (action === 'standby' && !isDeviceSignature(signature)))) return hide();
  const headers = new Headers({ 'X-RDP-Origin': url.origin, 'X-RDP-Profile': cap.profile, 'X-RDP-Device': cap.device });
  if (socket) {
    headers.set('Upgrade', 'websocket'); headers.set('Sec-WebSocket-Protocol', protocol);
    headers.set('X-RDP-Device-Proof', proof!);
    if (action === 'standby') { headers.set('X-RDP-Device-Signature', signature!); headers.set('X-RDP-Device-Token', cap.token); }
  }
  const db = env.USER_DB.get(env.USER_DB.idFromName(cap.route));
  return db.fetch(`https://internal/internal/rdp/device-${action}?user_id=${cap.uid}`, { method: request.method, headers });
}

/** Machine-only capabilities and authenticated browser routes never share an authorization path. */
export async function handleRdp(
  request: Request, url: URL, env: Env, assets: RdpAssets | undefined,
  ctx?: Partial<Pick<ExecutionContext, 'waitUntil'>>,
): Promise<Response> {
  if (!assets || url.protocol !== 'https:') return hide();
  const machine = deviceMachinePath.exec(url.pathname);
  if (machine) return assets.peer === undefined ? hide() : handleDeviceMachine(request, url, env, machine[1]);
  const isPeerWs = () => !url.search && request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && request.headers.get('Sec-WebSocket-Protocol') === PEER_PROTOCOL;
  if (request.method !== 'GET' || request.headers.has('Upgrade')) {
    if (request.headers.get('Origin') !== url.origin) return rdpJson({ code: 'forbidden' }, 403);
  }

  const user = await getAuthenticatedUser(request, env);
  if (!user) return rdpJson({ code: 'authentication_required' }, 401);
  const routeKey = await userDbRouteKey(user);
  const db = env.USER_DB.get(env.USER_DB.idFromName(routeKey));
  function call(path: string, method = 'GET', data?: unknown) {
    return db.fetch(new Request(`https://internal/internal/rdp/${path}?user_id=${user?.id}`, {
      method, headers: { 'X-RDP-Origin': url.origin, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }));
  }
  const path = url.pathname;
  if (path === API + 'peer/session') {
    const key = cookie(request, COOKIE);
    if (resolveAuthMode(env, request) === 'anonymous' || !env.RDP_AUTHORITY || !isPeerWs() || !/^[a-f0-9]{64}$/.test(key)) return hide();
    return db.fetch(new Request(`https://internal/internal/rdp/peer-browser?user_id=${user.id}`, { headers: {
      Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PEER_PROTOCOL, 'X-RDP-Binding': await binding(request, key),
      'X-RDP-Idle': String(parseIdleTimeout(env.IDLE_TIMEOUT)), 'X-RDP-Origin': url.origin,
    } }));
  }
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
        const response = await call('claim', 'POST', { ticket, binding: digest, supportsDirectPort: true });
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
    const match = /^profiles\/([a-f0-9-]{36})(\/(?:connect|trust|login-identity|peer-renew|connector|connector-setup))?$/.exec(resource);
    if (!match || !isRdpId(match[1])) return hide();
    const [, id, action] = match;
    if (action?.startsWith('/connector')) {
      if (!env.RDP_AUTHORITY || assets.peer === undefined) return hide();
      if (action === '/connector' && request.method === 'GET') return call(`profiles/${id}/connector`);
      if (request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CLIENT_REVISION)) return hide();
      if (action === '/connector' && request.method === 'DELETE') return call(`profiles/${id}/connector`, 'DELETE');
      if (action !== '/connector-setup' || request.method !== 'POST') return hide();
      const data = await readRdpJson(request) as { revision?: unknown } | null;
      if (typeof data?.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 1) return hide();
      // Check ownership and obvious conflicts before fetching the generic installer. The final write
      // underneath rechecks current revision and registration, so this snapshot is not authority.
      const current = await call(`profiles/${id}`);
      if (!current.ok) return current;
      const saved = await current.json<RdpProfile>();
      if (!saved.hasLogin || saved.revision !== data.revision ||
          (saved.connector && !['unbound', 'waiting'].includes(saved.connector.state))) {
        return rdpJson({ code: 'connector_unavailable' }, 409);
      }
      const base = await downloadRdpConnector(request.signal, fetch, assets.connectorPreview);
      if (!base.ok) return base;
      const template = await base.arrayBuffer().then(inspectRdpConnectorArchive, () => null);
      const unavailable = () => rdpJson({ code: 'connector_download_unavailable' }, 503);
      if (!template || request.signal.aborted) return unavailable();
      const proof = randomProof(), expires = Date.now() + ENROLL_MS;
      const grant = await signDeviceScope(env, request, 'e3', { route: routeKey, uid: user.id, profile: id, proof, expires });
      const body = personalRdpConnectorArchive(template, { version: 3, origin: url.origin, grant, expires,
        ...(resolveAuthMode(env, request) === 'cf_access' || env.CF_ACCESS === 'true' || hasVerifiedAccessContext(request) ? { accessRequired: true } : {}) });
      if (!body || request.signal.aborted) return unavailable();
      const prepared = await call(`profiles/${id}/connector-setup`, 'POST', { proof: await rdpDigest(proof), revision: data.revision, expires });
      if (!prepared.ok) return prepared;
      return new Response(body, { headers: {
        'Content-Type': 'application/zip', 'Content-Length': String(body.size),
        'Content-Disposition': `attachment; filename="${rdpConnectorSetupFilename(id)}"`,
        'Cache-Control': 'private, no-store, no-transform', 'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff', ...(assets.connectorPreview ? { 'X-CloudSSH-Connector-Build': 'test-unsigned' } : {}),
      } });
    }
    if (action === '/peer-renew' && request.method === 'POST') {
      if (!env.RDP_AUTHORITY || request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CLIENT_REVISION)) return hide();
      const data = await readRdpJson(request) as { lease?: string } | null;
      const key = cookie(request, COOKIE);
      if (!digestHex(key) || !isRdpId(data?.lease)) return hide();
      return call('peer-renew', 'POST', { profile: id, lease: data.lease, binding: await binding(request, key) });
    }
    if (action === '/login-identity' && request.method === 'POST') {
      if (request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CLIENT_REVISION)) return rdpJson({ code: 'refresh_client' }, 409);
      return call(`profiles/${id}/login-identity`, 'POST', await readRdpJson(request));
    }
    if (action === '/trust' && request.method === 'PUT') {
      if (request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CLIENT_REVISION)) return rdpJson({ code: 'refresh_client' }, 409);
      return call(`profiles/${id}/trust`, 'PUT', await readRdpJson(request));
    }
    if (action === '/connect' && request.method === 'POST') {
      if (request.headers.get('X-CloudSSH-RDP-Client') !== String(RDP_CONNECT_REVISION)) {
        return rdpJson({ code: 'refresh_client' }, 409);
      }
      const savedRevision = request.headers.get('X-CloudSSH-RDP-Saved-Revision');
      if (!savedRevision || !/^[1-9]\d{0,9}$/.test(savedRevision)) return rdpJson({ code: 'invalid_revision' }, 400);
      const clientKey = request.headers.get(RDP_CONNECT_KEY_HEADER);
      if (!isRdpConnectKey(clientKey)) return rdpJson({ code: 'invalid_request' }, 400);
      const transport = request.headers.get('X-CloudSSH-RDP-Transport');
      if (transport !== null && transport !== 'device') return hide();
      if (transport === 'device' && (!env.RDP_AUTHORITY || assets.peer === undefined)) return hide();
      let key = cookie(request, COOKIE);
      const issueCookie = !digestHex(key);
      if (issueCookie) key = newBrowserKey();
      const response = await call('ticket', 'POST', { profile: id, binding: await binding(request, key),
        clientKey, savedRevision: Number(savedRevision), ...(transport === 'device' ? { transport } : {}) });
      const data = await readRdpJson(response, request.signal);
      if (!response.ok) {
        const code = data && typeof data === 'object' && 'code' in data ? data.code : null;
        // Never relay arbitrary DO JSON/error bodies, including stale or mixed-version replies.
        return typeof code === 'string' && ticketErrors.has(code) && response.status >= 400
          ? rdpJson({ code }, response.status) : rdpJson({ code: 'login_unavailable' }, 500);
      }
      const grant = parseRdpConnectGrant(data);
      if (!grant || grant.revision !== Number(savedRevision)) return rdpJson({ code: 'refresh_client' }, 409);
      const result = rdpJson(grant);
      if (issueCookie) result.headers.append('Set-Cookie', `${COOKIE}=${key}; Path=/; Secure; HttpOnly; SameSite=Strict`);
      return result;
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
  if (assets.peer) resources.set('assets/rdp-peer.js', [assets.peer, 'text/javascript; charset=utf-8']);
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
