import { connect } from 'cloudflare:sockets';
import { parsePublic, parseTunnel, PROBE_ORIGIN, type RdpCheckEnv } from './probe';

type Target = 'public' | 'tunnel';
const MAX_BYTES_PER_DIRECTION = 16 * 1024 * 1024;
const MAX_BROWSER_FRAME = 256 * 1024;
const MAX_PENDING_INPUT = 512 * 1024;
const TUNNEL_FRAME = 16 * 1024;
const SESSION_MS = 180_000;
let active = false;

export function desktopConfig(env: RdpCheckEnv) {
  if (env.RDP_CHECK_ENABLE_DESKTOP !== '1') return null;
  const fingerprint = env.RDP_CHECK_CERT_SHA256?.toLowerCase();
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  return { fingerprint, public: !!parsePublic(env), tunnel: !!parseTunnel(env) };
}

/** Single-session, loopback-only prototype. Not a deployable relay or production transport. */
export function openDesktop(
  request: Request,
  env: RdpCheckEnv,
  target: Target,
  trustedOrigin = PROBE_ORIGIN,
  remainingMs = SESSION_MS
): Response {
  const url = new URL(request.url);
  if (
    url.origin !== trustedOrigin || url.search || request.method !== 'GET' ||
    request.headers.get('Origin') !== trustedOrigin ||
    request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
  ) return new Response(null, { status: 403 });

  if (remainingMs <= 0 || !desktopConfig(env)) return new Response(null, { status: 404 });
  const direct = target === 'public' ? parsePublic(env) : null;
  const tunnel = target === 'tunnel' ? parseTunnel(env) : null;
  if (!direct && !tunnel) return new Response(null, { status: 404 });
  if (active) return new Response(null, { status: 409 });

  const [client, browser] = Object.values(new WebSocketPair());
  browser.binaryType = 'arraybuffer';
  browser.accept();
  active = true;
  let closed = false;
  let tcp: ReturnType<typeof connect> | undefined;
  let carrier: WebSocket | undefined;
  let sent = 0;
  let received = 0;
  let pending = 0;
  let writeChain = Promise.resolve();
  const controller = new AbortController();
  const sessionTimer = setTimeout(() => finish(1000, 'Test session ended'), Math.min(SESSION_MS, remainingMs));
  const openTimer = setTimeout(() => finish(1011, 'Upstream unavailable'), 5000);

  function finish(code = 1000, reason = 'Session closed') {
    if (closed) return;
    closed = true;
    active = false;
    clearTimeout(sessionTimer);
    clearTimeout(openTimer);
    controller.abort();
    try { browser.close(code, reason); } catch { /* already closed */ }
    try { carrier?.close(1000, 'Session closed'); } catch { /* already closed */ }
    void tcp?.close().catch(() => {});
  }

  function output(data: Uint8Array) {
    if (closed || !data.byteLength) return;
    received += data.byteLength;
    if (received > MAX_BYTES_PER_DIRECTION) {
      finish(1008, 'Local test transfer limit');
      return;
    }
    browser.send(data);
  }

  const upstream = (async (): Promise<(data: Uint8Array) => Promise<void>> => {
    try {
      if (direct) {
        tcp = connect({ hostname: direct[0], port: direct[1] });
        void tcp.closed.catch(() => finish(1011, 'Upstream closed'));
        await tcp.opened;
        if (closed) throw new Error('closed');
        const reader = tcp.readable.getReader();
        const writer = tcp.writable.getWriter();
        controller.signal.addEventListener('abort', () => {
          void writer.abort().catch(() => {}).finally(() => writer.releaseLock());
        }, { once: true });
        void (async () => {
          try {
            while (!closed) {
              const frame = await reader.read();
              if (frame.done) break;
              output(frame.value);
            }
            finish();
          } catch { finish(1011, 'Upstream read failed'); }
          finally { reader.releaseLock(); }
        })();
        return (data) => writer.write(data);
      }
      if (!tunnel) throw new Error('missing target');
      const response = await fetch(`https://${tunnel[0]}/`, {
        headers: tunnel[1], redirect: 'manual', signal: controller.signal,
      });
      if (response.status !== 101 || !response.webSocket) {
        void response.body?.cancel().catch(() => {});
        throw new Error('upgrade failed');
      }
      carrier = response.webSocket;
      carrier.binaryType = 'arraybuffer';
      carrier.addEventListener('message', ({ data }) => {
        if (!(data instanceof ArrayBuffer)) return finish(1003, 'Expected binary data');
        try { output(new Uint8Array(data)); }
        catch { finish(1011, 'Browser send failed'); }
      });
      carrier.addEventListener('close', () => finish());
      carrier.addEventListener('error', () => finish(1011, 'Tunnel closed'));
      carrier.accept();
      if (closed) {
        carrier.close(1000, 'Session closed');
        throw new Error('closed');
      }
      const ws = carrier;
      return async (data) => {
        for (let offset = 0; offset < data.byteLength && !closed; offset += TUNNEL_FRAME) {
          ws.send(data.subarray(offset, offset + TUNNEL_FRAME));
        }
      };
    } finally { clearTimeout(openTimer); }
  })();
  void upstream.catch(() => finish(1011, 'Upstream unavailable'));

  browser.addEventListener('message', ({ data }) => {
    if (closed) return;
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > MAX_BROWSER_FRAME) {
      finish(1003, 'Invalid browser data');
      return;
    }
    sent += data.byteLength;
    pending += data.byteLength;
    if (sent > MAX_BYTES_PER_DIRECTION || pending > MAX_PENDING_INPUT) {
      finish(1008, 'Local test transfer limit');
      return;
    }
    writeChain = writeChain.then(async () => {
      const send = await upstream;
      if (!closed) await send(new Uint8Array(data));
    }).catch(() => {
      finish(1011, 'Upstream write failed');
    }).finally(() => { pending -= data.byteLength; });
  });
  browser.addEventListener('close', () => finish());
  browser.addEventListener('error', () => finish(1011, 'Browser closed'));
  return new Response(null, { status: 101, webSocket: client });
}
