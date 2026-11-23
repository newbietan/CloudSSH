export type RdpRoute = 'direct' | 'tunnel';
export const RDP_MAX_PROFILES = 32;
export const RDP_MAX_BODY = 4096;
export const RDP_WINDOW = 1024 * 1024;
export const RDP_FRAME = 16 * 1024;
export const RDP_WS_PROTOCOL = 'cloudssh-rdp-v1';
export const RDP_CLIENT_REVISION = 1;

export interface RdpProfileInput {
  name: string;
  route: RdpRoute;
  host: string;
  fingerprint: string;
  accessId?: string;
  accessSecret?: string;
}
export interface RdpProfile extends Omit<RdpProfileInput, 'accessId' | 'accessSecret'> {
  id: string;
  revision: number;
  hasAccessToken: boolean;
}

/** Direct endpoints intentionally accept public IPv4 literals only in the first version. */
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

export function isRdpTunnelHost(value: string): boolean {
  return value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}
export function isRdpId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}
export function parseRdpProfile(value: unknown): RdpProfileInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['name', 'route', 'host', 'fingerprint', 'accessId', 'accessSecret', 'revision'].includes(key))) return null;
  if (typeof data.name !== 'string' || typeof data.host !== 'string' || typeof data.fingerprint !== 'string') return null;
  const name = data.name.trim();
  const host = data.host.trim().toLowerCase();
  const fingerprint = data.fingerprint.trim().toLowerCase().replace(/:/g, '');
  const route = data.route;
  if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name) || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  if (route === 'direct') {
    if (!isPublicRdpIPv4(host) || data.accessId !== undefined || data.accessSecret !== undefined) return null;
    return { name, host, fingerprint, route };
  }
  if (route !== 'tunnel' || !isRdpTunnelHost(host)) return null;
  const accessId = data.accessId;
  const accessSecret = data.accessSecret;
  if (accessId === undefined && accessSecret === undefined) return { name, host, fingerprint, route };
  if (typeof accessId !== 'string' || typeof accessSecret !== 'string') return null;
  if (accessId === '' && accessSecret === '') return { name, host, fingerprint, route, accessId, accessSecret };
  if (!/^[!-~]{1,256}$/.test(accessId) || !/^[!-~]{1,512}$/.test(accessSecret)) return null;
  return { name, host, fingerprint, route, accessId, accessSecret };
}

export async function readRdpJson(request: Pick<Request | Response, 'body' | 'headers'>): Promise<unknown> {
  const length = request.headers.get('Content-Length');
  if (!request.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > RDP_MAX_BODY))) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(RDP_MAX_BODY);
  let offset = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 5000);
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
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
