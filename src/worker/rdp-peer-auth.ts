import type { Env } from '../types';
import {
  hasVerifiedAccessContext,
  isConnectTokenRouteAllowed,
  isSshIdentityAllowed,
  resolveAuthMode,
} from './auth';
import { isRdpId } from '../rdp-schema';

export const PEER_PAIR_MS = 5 * 60_000;
export const PEER_PROTOCOL = 'cloudssh-rdp-peer-v1';
export const peerEnabled = (env: Env) => /^[a-f0-9]{64}$/.test(env.RDP_P2P_SECRET ?? '');
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
export const randomProof = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);

// Authenticate the complete routing envelope BEFORE allocating a UserDB shard. The random
// proof additionally has to match and atomically consume a browser-bound row in that shard.
async function mac(env: Env, request: Request, payload: string) {
  const mode = resolveAuthMode(env, request);
  const text = [
    new URL(request.url).origin,
    mode,
    mode === 'password' ? env.ADMIN_PASSWORD_HASH : '',
    payload,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.RDP_P2P_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  return { key, data: new TextEncoder().encode(text) };
}
export async function makePeerCode(
  env: Env,
  req: Request,
  route: string,
  uid: number,
  id: string,
  proof: string
) {
  const payload = ['p1', route, uid, id, Date.now() + PEER_PAIR_MS, proof].join('.');
  const { key, data } = await mac(env, req, payload);
  return payload + '.' + hex(await crypto.subtle.sign('HMAC', key, data));
}
export async function verifyPeerCode(env: Env, req: Request) {
  if (!peerEnabled(env)) return null;
  const auth = req.headers.get('Authorization') ?? '';
  if (auth.length > 290 || !auth.startsWith('Bearer p1.')) return null;
  const parts = auth.slice(7).split('.');
  if (parts.length !== 7) return null;
  const [, route, uid, id, expiry, proof, signature] = parts;
  const mode = resolveAuthMode(env, req),
    now = Date.now();
  if (
    mode === 'anonymous' ||
    !/^(?:cf-[a-f0-9]{32}|-1|[1-9]\d{0,15})$/.test(route) ||
    !isConnectTokenRouteAllowed(mode, route) ||
    (mode === 'cf_access' && !hasVerifiedAccessContext(req)) ||
    (mode === 'github' && !isSshIdentityAllowed(env, route)) ||
    !/^[1-9]\d{0,14}$/.test(uid) ||
    !isRdpId(id) ||
    !/^\d{13}$/.test(expiry) ||
    +expiry <= now ||
    +expiry > now + PEER_PAIR_MS ||
    !/^[a-f0-9]{64}$/.test(proof) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null;
  const { key, data } = await mac(env, req, parts.slice(0, -1).join('.'));
  const sig = Uint8Array.from(signature.match(/../g)!, (b) => parseInt(b, 16));
  return (await crypto.subtle.verify('HMAC', key, sig, data))
    ? { route, uid: +uid, id, proof }
    : null;
}
