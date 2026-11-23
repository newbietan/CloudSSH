import { isValidTunnelHostname } from '../../../src/worker/tunnel-stream';

export const PROBE_ORIGIN = 'http://127.0.0.1:8791';
export const PROBE_TIMEOUT_MS = 5_000;

type Route = 'public' | 'tunnel';
type TunnelStatus = 101 | 302 | 401 | 403;
type Result = 'direct_tcp_open' | 'tunnel_ws_open' | 'tunnel_access_denied' | 'unreachable';

export interface RdpCheckEnv {
  RDP_CHECK_PUBLIC_IP?: string;
  RDP_CHECK_PUBLIC_PORT?: string;
  RDP_CHECK_TUNNEL_HOST?: string;
  RDP_CHECK_ACCESS_ID?: string;
  RDP_CHECK_ACCESS_SECRET?: string;
  RDP_CHECK_ENABLE_DESKTOP?: string;
  RDP_CHECK_CERT_SHA256?: string;
}

export interface RdpCheckIO {
  checkTcp(ip: string, port: number, signal: AbortSignal): Promise<void>;
  checkTunnel(host: string, headers: Headers, signal: AbortSignal): Promise<TunnelStatus>;
}

function isPublicIPv4(ip: string): boolean {
  const octets = ip.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^(0|[1-9]\d{0,2})$/.test(octet))) {
    return false;
  }
  const [a, b, c] = octets.map(Number);
  return (
    octets.every((octet) => Number(octet) <= 255) &&
    a > 0 &&
    a < 224 &&
    ![10, 127].includes(a) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}

export function parsePublic(env: RdpCheckEnv): [ip: string, port: number] | null {
  const ip = env.RDP_CHECK_PUBLIC_IP ?? '';
  const port = env.RDP_CHECK_PUBLIC_PORT ?? '3389';
  if (!isPublicIPv4(ip) || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65_535) return null;
  return [ip, Number(port)];
}

export function parseTunnel(env: RdpCheckEnv): [host: string, headers: Headers] | null {
  const host = env.RDP_CHECK_TUNNEL_HOST ?? '';
  // Trust operator configuration only. Do not accept URLs, custom headers or destinations in a request.
  if (host !== host.toLowerCase().trim() || !isValidTunnelHostname(host)) return null;
  const id = env.RDP_CHECK_ACCESS_ID ?? '';
  const secret = env.RDP_CHECK_ACCESS_SECRET ?? '';
  const validTokenPart = (value: string) => /^[!-~]{1,512}$/.test(value);
  if ((id || secret) && (!validTokenPart(id) || !validTokenPart(secret))) return null;

  const headers = new Headers({
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Version': '13',
  });
  if (id) {
    headers.set('CF-Access-Client-Id', id);
    headers.set('CF-Access-Client-Secret', secret);
  }
  return [host, headers];
}

const status: Record<Result, number> = {
  direct_tcp_open: 200,
  tunnel_ws_open: 200,
  tunnel_access_denied: 502,
  unreachable: 502,
};

function result(code: string, responseStatus: number): Response {
  return Response.json({ code }, { status: responseStatus, headers: { 'Cache-Control': 'no-store' } });
}

/** Local reachability check only. Never forwards data, logs secrets, or attempts Windows login. */
export function createRdpCheck(io: RdpCheckIO, timeoutMs = PROBE_TIMEOUT_MS) {
  let inFlight = false;
  return async (request: Request, env: RdpCheckEnv): Promise<Response> => {
    const url = new URL(request.url);
    let route: Route;
    if (url.origin !== PROBE_ORIGIN || url.search) return result('not_found', 404);
    if (url.pathname === '/check/public') route = 'public';
    else if (url.pathname === '/check/tunnel') route = 'tunnel';
    else return result('not_found', 404);
    if (request.method !== 'POST') return result('method_not_allowed', 405);
    if (request.headers.get('Origin') !== PROBE_ORIGIN) return result('origin_required', 403);
    // Wrangler can supply a stream for an empty POST; accept an explicit zero length.
    const length = request.headers.get('Content-Length');
    if (
      request.headers.has('Transfer-Encoding') ||
      (length !== null && length !== '0') ||
      (length === null && request.body !== null)
    ) {
      return result('body_not_allowed', 400);
    }
    if (inFlight) return result('busy', 409);

    const tcp = route === 'public' ? parsePublic(env) : null;
    const tunnel = route === 'tunnel' ? parseTunnel(env) : null;
    if (!tcp && !tunnel) return result('invalid_local_config', 400);

    inFlight = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('deadline'));
          controller.abort();
        }, timeoutMs);
      });
      const attempt = async (): Promise<Result> => {
        if (tcp) {
          await io.checkTcp(...tcp, controller.signal);
          return 'direct_tcp_open';
        }
        if (!tunnel) return 'unreachable';
        const tunnelStatus = await io.checkTunnel(...tunnel, controller.signal);
        return tunnelStatus === 101 ? 'tunnel_ws_open' : 'tunnel_access_denied';
      };
      const code = await Promise.race([deadline, attempt()]);
      return result(code, status[code]);
    } catch {
      return controller.signal.aborted ? result('timeout', 504) : result('unreachable', 502);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlight = false;
    }
  };
}
