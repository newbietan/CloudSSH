import { isRdpId, readRdpJson } from '../rdp-schema';
import type { Env } from '../types';
import {
  hasVerifiedAccessContext,
  isConnectTokenRouteAllowed,
  isSshIdentityAllowed,
  resolveAuthMode,
} from './auth';

export const ENROLL_MS = 15 * 60_000;
export const STANDBY_PROTOCOL = 'cloudssh-rdp-device-v2';
export const PEER_PROTOCOL = 'cloudssh-rdp-peer-v2';
export const DEVICE_PING = 'cloudssh-rdp-device-ping-v2';
export const DEVICE_PONG = 'cloudssh-rdp-device-pong-v2';
export const deviceMachinePath = /^\/api\/rdp\/device\/(register|challenge|standby|attach)$/;
export const digestHex = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const deviceLabel = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(v);
const encoder = new TextEncoder();
const bytesToHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
export const randomProof = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const fromHex = (str: string) => Uint8Array.from(str.match(/../g)!, (b) => Number.parseInt(b, 16));
const b64url = (str: unknown, size: number) => {
  if (
    typeof str !== 'string' ||
    str.length !== Math.ceil((size * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(str)
  )
    return null;
  try {
    const raw = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    if (
      raw.length !== size ||
      btoa(raw).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== str
    )
      return null;
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
export const isDeviceKey = (v: unknown): v is string => b64url(v, 32) !== null;
export const isDeviceSignature = (v: unknown): v is string => b64url(v, 64) !== null;
export async function verifyDeviceSignature(
  key: string,
  sig: string,
  message: string
): Promise<boolean> {
  const raw = b64url(key, 32),
    signature = b64url(sig, 64);
  if (!raw || !signature) return false;
  try {
    const publicKey = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', publicKey, signature, encoder.encode(message));
  } catch {
    return false;
  }
}
export async function deviceKeyFingerprint(key: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', b64url(key, 32)!));
}
export const registrationMessage = (token: string, key: string, label: string) =>
  `cloudssh-rdp-register-v3\n${token}\n${key}\n${label}`;
export const standbyMessage = (token: string, challenge: string) =>
  `cloudssh-rdp-standby-v2\n${token}\n${challenge}`;

interface Scope {
  route: string;
  uid: number;
  profile: string;
}
export interface EnrollScope extends Scope {
  expires: number;
  proof: string;
}
export interface DeviceScope extends Scope {
  device: string;
}
// New download-to-bind grants never accept old manual-confirmation capabilities.
type ScopeByKind = { e3: EnrollScope; d2: DeviceScope };

/** One stable key per deployment; no external route exposes the key or permits signing arbitrary input. */
export class RdpAuthorityDO {
  private key?: CryptoKey;
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || (path !== '/sign' && path !== '/verify'))
      return new Response(null, { status: 404 });
    const body = (await readRdpJson(request)) as { input?: unknown; signature?: unknown } | null;
    if (
      typeof body?.input !== 'string' ||
      body.input.length > 1024 ||
      (path === '/verify' && !digestHex(body.signature))
    )
      return new Response(null, { status: 400 });
    if (!this.key) {
      const raw = await this.state.storage.transaction(async (txn) => {
        const stored = await txn.get<ArrayBuffer>('rdp-signing-key-v2');
        if (stored || path === '/verify') return stored;
        const value = crypto.getRandomValues(new Uint8Array(32)).buffer;
        await txn.put('rdp-signing-key-v2', value);
        return value;
      });
      if (!raw || raw.byteLength !== 32) return new Response(null, { status: 403 });
      this.key = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
      );
    }
    const input = encoder.encode(body.input);
    if (path === '/verify') {
      const ok = await crypto.subtle.verify(
        'HMAC',
        this.key,
        fromHex(body.signature as string),
        input
      );
      return new Response(null, { status: ok ? 204 : 403 });
    }
    return Response.json({
      signature: bytesToHex(await crypto.subtle.sign('HMAC', this.key, input)),
    });
  }
}

async function authority(
  env: Env,
  path: 'sign' | 'verify',
  request: Request,
  payload: string,
  signature?: string
) {
  const ns = env.RDP_AUTHORITY;
  if (!ns) return null;
  const mode = resolveAuthMode(env, request);
  // Password rotation invalidates pending enrollment, but does not change installed device identity.
  const epoch =
    payload.startsWith('e3.') && mode === 'password'
      ? bytesToHex(
          await crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_PASSWORD_HASH ?? ''))
        )
      : '';
  const input = `cloudssh-rdp-capability-v2\n${new URL(request.url).origin}\n${mode}\n${epoch}\n${payload}`;
  return ns.get(ns.idFromName('rdp-device-authority-v2')).fetch(`https://internal/${path}`, {
    method: 'POST',
    body: JSON.stringify({ input, signature }),
  });
}
export function signDeviceScope(
  env: Env,
  req: Request,
  kind: 'e3',
  value: EnrollScope
): Promise<string>;
export function signDeviceScope(
  env: Env,
  req: Request,
  kind: 'd2',
  value: DeviceScope
): Promise<string>;
export async function signDeviceScope(
  env: Env,
  req: Request,
  kind: keyof ScopeByKind,
  value: EnrollScope | DeviceScope
) {
  const enrollment = value as EnrollScope;
  const suffix =
    kind === 'e3' ? `${enrollment.expires}.${enrollment.proof}` : (value as DeviceScope).device;
  const payload = `${kind}.${value.route}.${value.uid}.${value.profile}.${suffix}`;
  const res = await authority(env, 'sign', req, payload);
  const signature: unknown = res?.ok ? (await res.json<{ signature?: unknown }>()).signature : null;
  if (!digestHex(signature)) throw new Error('RDP authority unavailable');
  return `${payload}.${signature}`;
}
export function verifyDeviceScope(
  env: Env,
  req: Request,
  kind: 'e3'
): Promise<(EnrollScope & { token: string }) | null>;
export function verifyDeviceScope(
  env: Env,
  req: Request,
  kind: 'd2'
): Promise<(DeviceScope & { token: string }) | null>;
export async function verifyDeviceScope(env: Env, req: Request, kind: 'e3' | 'd2') {
  const header = req.headers.get('Authorization') ?? '';
  if (
    header.length > 295 ||
    !header.startsWith(`Bearer ${kind}.`) ||
    req.headers.has('Cookie') ||
    req.headers.has('Origin')
  )
    return null;
  const token = header.slice(7),
    parts = token.split('.');
  if (parts.length !== (kind === 'e3' ? 7 : 6)) return null;
  const [, route, rawUid, profile, first, second] = parts;
  const mode = resolveAuthMode(env, req),
    uid = Number(rawUid),
    now = Date.now();
  if (
    mode === 'anonymous' ||
    !/^(?:cf-[a-f0-9]{32}|-1|[1-9]\d{0,15})$/.test(route) ||
    !isConnectTokenRouteAllowed(mode, route) ||
    (mode === 'github' && !isSshIdentityAllowed(env, route)) ||
    ((mode === 'cf_access' || env.CF_ACCESS === 'true') && !hasVerifiedAccessContext(req)) ||
    !/^[1-9]\d{0,14}$/.test(rawUid) ||
    !isRdpId(profile) ||
    !digestHex(parts.at(-1))
  )
    return null;
  const expires = Number(first);
  if (
    kind === 'e3'
      ? !/^\d{13}$/.test(first) || expires <= now || expires > now + ENROLL_MS || !digestHex(second)
      : !isRdpId(first)
  )
    return null;
  const res = await authority(env, 'verify', req, parts.slice(0, -1).join('.'), parts.at(-1));
  if (res?.status !== 204) return null;
  return {
    route,
    uid,
    profile,
    token,
    ...(kind === 'e3' ? { expires, proof: second } : { device: first }),
  };
}
