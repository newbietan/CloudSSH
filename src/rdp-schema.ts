import { normalizeServerTags } from './server-tags';
import { isRestrictedTcpPort } from './tcp-port-policy';

export type RdpRoute = 'direct' | 'tunnel';
export const RDP_MAX_PROFILES = 32;
export const RDP_MAX_BODY = 12 * 1024;
export const RDP_WINDOW = 1024 * 1024;
export const RDP_FRAME = 16 * 1024;
export const RDP_WS_PROTOCOL = 'cloudssh-rdp-v1';
export const RDP_CLIENT_REVISION = 5;
export const RDP_DEFAULT_PORT = 3389;

export function isRdpPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 && !isRestrictedTcpPort(value);
}

export interface RdpLogin { username: string; domain: string; password: string }
export function isRdpLogin(value: unknown): value is RdpLogin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { username, domain, password } = value as Record<string, unknown>;
  return Object.keys(value).length === 3 && typeof username === 'string' && !!username.trim() && username.length <= 128 &&
    typeof domain === 'string' && domain.length <= 128 && typeof password === 'string' && !!password &&
    ![username, domain, password].some(s => /[\x00\r\n]/.test(s)) && new TextEncoder().encode(password).length <= 1024;
}

export interface RdpProfileInput {
  name: string;
  route: RdpRoute;
  host: string;
  port?: number; // Direct only. Omission on edit preserves the existing direct port.
  tags?: string[];
  login?: RdpLogin;
  accessId?: string;
  accessSecret?: string;
}
export interface RdpProfile extends Omit<RdpProfileInput, 'accessId' | 'accessSecret' | 'login'> {
  id: string;
  revision: number;
  fingerprint: string | null;
  hasAccessToken: boolean;
  hasLogin: boolean;
  tags: string[];
}

/** Authenticated card projection. No domain, password, token or encrypted login blob. */
export interface RdpCard extends RdpProfile {
  username: string | null;
  last_connected_at: number | null;
  created_at: number | null;
  updated_at: number | null;
}

export function isPublicRdpIPv4(value: string): boolean {
  const components = value.split('.');
  if (components.length !== 4 || components.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) return false;
  const [a, b, c, d] = components.map(Number);
  return Math.max(a, b, c, d) <= 255 && a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113);
}

/** Return the unbracketed, canonical literal. Do not admit scoped or mapped addresses. */
export function normalizePublicRdpIPv6(value: string): string | null {
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (!bare.includes(':') || !/^[\da-f:.]{2,45}$/i.test(bare)) return null;
  try {
    const ip = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
    const [a, b = ''] = ip.split(':', 2);
    const first = Number.parseInt(a, 16);
    const second = b ? Number.parseInt(b, 16) : 0;
    // Global unicast only. Exclude protocol/special-use, transition and documentation space.
    if (first < 0x2000 || first > 0x3fff || !Number.isFinite(first) ||
        (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) ||
        first === 0x2002 || first === 0x3ffe || (first === 0x3fff && second <= 0xfff)) return null;
    return ip;
  } catch { return null; }
}

export type RdpDirectHost = { kind: 'ipv4' | 'ipv6' | 'domain'; host: string };

/** Classify a saved endpoint, not its reachability. Domains must be resolved at dial time. */
export function parseRdpDirectHost(input: string): RdpDirectHost | null {
  const value = input.trim();
  if (value.length > 254) return null;
  if (isPublicRdpIPv4(value)) return { kind: 'ipv4', host: value };
  if (value.includes(':')) {
    const ip = normalizePublicRdpIPv6(value);
    return ip ? { kind: 'ipv6', host: ip } : null;
  }
  // The URL parser provides IDNA canonicalization, not URL input or alternate IPv4 spellings.
  if (!value || /[\s\x00-\x1f\x7f/\\?#@%\[\]]/u.test(value)) return null;
  try {
    const host = new URL(`http://${value}/`).hostname.replace(/\.$/, '');
    const labels = host.split('.');
    const tld = labels.at(-1) ?? '';
    if (host.length > 253 || labels.length < 2 || !/[a-z]/.test(tld) ||
        !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion'].includes(tld) ||
        host === 'home.arpa' || host.endsWith('.home.arpa')) return null;
    return { kind: 'domain', host };
  } catch { return null; }
}

export function isRdpTunnelHost(value: string): boolean {
  return value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}
export function isRdpId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}
export function parseRdpProfile(value: unknown): RdpProfileInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['name', 'tags', 'login', 'route', 'host', 'port', 'accessId', 'accessSecret', 'revision'].includes(key))) return null;
  if (typeof data.name !== 'string' || typeof data.host !== 'string') return null;
  const name = data.name.trim();
  const host = data.host.trim().toLowerCase();
  const route = data.route;
  if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) return null;
  if (data.tags !== undefined && !Array.isArray(data.tags)) return null;
  if (data.login !== undefined && !isRdpLogin(data.login)) return null;
  const extra = { ...(data.tags === undefined ? {} : { tags: normalizeServerTags(data.tags) }),
    ...(data.login === undefined ? {} : { login: data.login }) };
  if (route === 'direct') {
    const direct = parseRdpDirectHost(data.host);
    if (!direct || data.accessId !== undefined || data.accessSecret !== undefined) return null;
    if (data.port !== undefined && !isRdpPort(data.port)) return null;
    return { name, host: direct.host, route, ...(data.port === undefined ? {} : { port: data.port }), ...extra };
  }
  if (route !== 'tunnel' || data.port !== undefined || !isRdpTunnelHost(host)) return null;
  const accessId = data.accessId;
  const accessSecret = data.accessSecret;
  if (accessId === undefined && accessSecret === undefined) return { name, host, route, ...extra };
  if (typeof accessId !== 'string' || typeof accessSecret !== 'string') return null;
  if (accessId === '' && accessSecret === '') return { name, host, route, accessId, accessSecret, ...extra };
  if (!/^[!-~]{1,256}$/.test(accessId) || !/^[!-~]{1,512}$/.test(accessSecret)) return null;
  return { name, host, route, accessId, accessSecret, ...extra };
}

export async function readRdpJson(request: Pick<Request | Response, 'body' | 'headers'>, signal?: AbortSignal): Promise<unknown> {
  const length = request.headers.get('Content-Length');
  if (!request.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > RDP_MAX_BODY))) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(RDP_MAX_BODY);
  let offset = 0;
  let expired = false;
  const cancel = () => { expired = true; void reader.cancel().catch(() => {}); };
  const timer = setTimeout(cancel, 5000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) return null;
      bytes.set(value, offset);
      offset += value.length;
    }
    return expired ? null : JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, offset)));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
