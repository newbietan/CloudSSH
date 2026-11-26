import type { RdpLogin } from '../rdp-schema';

const curve = { name: 'ECDH', namedCurve: 'P-256' } as const;
// Workers' generated types do not model the standard `public` ECDH parameter or key-pair result.
function ecdhSubtle() {
  return crypto.subtle as unknown as {
    generateKey(algorithm: typeof curve, extractable: boolean, usages: string[]): Promise<CryptoKeyPair>;
    exportKey(format: 'raw', key: CryptoKey): Promise<ArrayBuffer>;
    deriveBits(algorithm: { name: 'ECDH'; public: CryptoKey }, key: CryptoKey, length: number): Promise<ArrayBuffer>;
  };
}
const encoder = new TextEncoder();
const MAX_CIPHERTEXT = 8 * 1024; // Includes the tag and worst-case JSON escaping of a valid RdpLogin.
const toUrl = (value: string) => btoa(value).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const encode = (bytes: Uint8Array) => toUrl(String.fromCharCode(...bytes));

function decode(value: unknown, min: number, max = min) {
  if (typeof value !== 'string' || value.length < Math.ceil(min * 4 / 3) ||
      value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    if (raw.length < min || raw.length > max || toUrl(raw) !== value) return null;
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch { return null; }
}

function point(value: unknown) {
  const bytes = decode(value, 65);
  return bytes?.[0] === 4 ? bytes : null; // Uncompressed SEC1 P-256 public point only.
}
export const isRdpConnectKey = (value: unknown): value is string => point(value) !== null;

export async function importRdpConnectKey(encoded: string) {
  const raw = point(encoded);
  if (!raw) return null;
  try {
    return { encoded, publicKey: await crypto.subtle.importKey('raw', raw, curve, false, []) };
  } catch { return null; } // Native WebCrypto validates curve membership before any login is read.
}

export interface RdpLoginContext {
  origin: string;
  profile: string;
  revision: number;
  transport: 'device' | 'relay';
  ticket: string;
}
export interface RdpLoginEnvelope {
  version: 1;
  senderKey: string;
  iv: string;
  ciphertext: string;
}
export interface RdpConnectGrant {
  ticket: string;
  revision: number;
  loginEnvelope: RdpLoginEnvelope;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Public Worker response boundary, including during mixed-version Worker / UserDB deployments. */
export function parseRdpConnectGrant(value: unknown): RdpConnectGrant | null {
  const grant = record(value);
  if (!grant || Object.keys(grant).length !== 3 || typeof grant.ticket !== 'string' ||
      !/^[a-f0-9]{64}$/.test(grant.ticket) || typeof grant.revision !== 'number' ||
      !Number.isSafeInteger(grant.revision) || grant.revision < 1) return null;
  const box = record(grant.loginEnvelope);
  if (!box || Object.keys(box).length !== 4 || box.version !== 1 || !isRdpConnectKey(box.senderKey) ||
      typeof box.iv !== 'string' || !decode(box.iv, 12) || typeof box.ciphertext !== 'string' ||
      !decode(box.ciphertext, 17, MAX_CIPHERTEXT)) return null;
  return { ticket: grant.ticket, revision: grant.revision,
    loginEnvelope: { version: 1, senderKey: box.senderKey, iv: box.iv, ciphertext: box.ciphertext } };
}

/** Seals one login for the initiating frame. Keep the wire format aligned with desktop.rdp-text. */
export async function sealRdpLogin(
  login: RdpLogin,
  recipient: NonNullable<Awaited<ReturnType<typeof importRdpConnectKey>>>,
  context: RdpLoginContext,
): Promise<RdpLoginEnvelope> {
  const ecdh = ecdhSubtle();
  const sender = await ecdh.generateKey(curve, false, ['deriveBits']);
  const senderKey = encode(new Uint8Array(await ecdh.exportKey('raw', sender.publicKey)));
  const aad = encoder.encode(JSON.stringify([
    'cloudssh-rdp-login-v1', context.origin, context.profile, context.revision,
    context.transport, context.ticket, recipient.encoded, senderKey,
  ]));
  const bits = await ecdh.deriveBits({ name: 'ECDH', public: recipient.publicKey }, sender.privateKey, 256);
  let hkdf: CryptoKey;
  try { hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']); }
  finally { new Uint8Array(bits).fill(0); }
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(context.ticket), info: aad }, hkdf,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify(login));
  try {
    if (plain.byteLength + 16 > MAX_CIPHERTEXT) throw new Error('login exceeds envelope budget');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aes, plain);
    return { version: 1, senderKey, iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)) };
  } finally { plain.fill(0); }
}
