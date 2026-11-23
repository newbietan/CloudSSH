import { connect } from 'cloudflare:sockets';
import { RDP_FRAME, RDP_WINDOW, isPublicRdpIPv4, isRdpTunnelHost, readRdpJson } from '../rdp-schema';
import { isBlockedIP } from './dns-check';
import type { RdpLease } from './rdp-store';

// Tunnel carriers do not expose drain or peer acknowledgments to Workers.
// Bound the worst-case queued writes over the lifetime (keyboard/display control only).
const MAX_TUNNEL_UPLOAD = 8 * 1024 * 1024;

export interface RdpTransport {
  read(deliver: (data: Uint8Array) => Promise<void>): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
}

function publicV6(value: string): boolean {
  try {
    const ip = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    return /^[23]/.test(ip) && !isBlockedIP(ip) && !/^(2001:(?:db8|0|10|20):|2001::|2002:|3fff:)/i.test(ip);
  } catch { return false; }
}

export async function checkRdpTunnelHost(host: string, signal: AbortSignal): Promise<void> {
  if (!isRdpTunnelHost(host)) throw new Error('invalid_tunnel');
  const answers = await Promise.all([1, 28].map(async (type) => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal,
    });
    if (!response.ok) throw new Error('dns_failed');
    // Same bounded reader used for Worker requests; never buffer an unbounded DNS reply.
    const json = await readRdpJson(response);
    const result = json as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] } | null;
    if (!result || result.Status !== 0 || (result.Answer !== undefined && !Array.isArray(result.Answer))) throw new Error('dns_failed');
    const ips: string[] = [];
    for (const answer of result.Answer ?? []) {
      if (answer?.type !== type) continue;
      const ip = answer.data;
      if (typeof ip !== 'string' || !(type === 1 ? isPublicRdpIPv4(ip) : publicV6(ip))) throw new Error('dns_blocked');
      ips.push(ip);
    }
    return ips.length;
  }));
  if (answers[0] + answers[1] === 0) throw new Error('dns_failed');
}

export async function openRdpTransport(lease: RdpLease, signal: AbortSignal): Promise<RdpTransport> {
  const { host, route } = lease.profile;
  signal.throwIfAborted();
  if (route === 'direct') {
    if (!isPublicRdpIPv4(host)) throw new Error('invalid_target');
    const socket = connect({ hostname: host, port: 3389 });
    const close = () => { void socket.close().catch(() => {}); };
    signal.addEventListener('abort', close, { once: true });
    void socket.closed.catch(() => {});
    try {
      await socket.opened;
      signal.throwIfAborted();
      const writer = socket.writable.getWriter();
      let released = false;
      const finish = () => {
        if (released) return;
        released = true;
        signal.removeEventListener('abort', close);
        close();
        void writer.abort().catch(() => {}).finally(() => writer.releaseLock());
      };
      return {
        async read(deliver) {
          const reader = socket.readable.getReader();
          try {
            for (;;) {
              const frame = await reader.read();
              if (frame.done) return;
              await deliver(frame.value);
            }
          } finally { reader.releaseLock(); }
        },
        write: data => writer.write(data),
        close: finish,
      };
    } catch (err) { close(); throw err; }
  }
  await checkRdpTunnelHost(host, signal);
  const headers = new Headers({ Upgrade: 'websocket' });
  if (lease.accessId && lease.accessSecret) {
    headers.set('CF-Access-Client-Id', lease.accessId);
    headers.set('CF-Access-Client-Secret', lease.accessSecret);
  }
  const response = await fetch(`https://${host}/`, { headers, redirect: 'manual', signal });
  const upstream = response.webSocket;
  if (response.status !== 101 || !upstream) {
    void response.body?.cancel().catch(() => {});
    throw new Error('tunnel_unavailable');
  }
  const ws: WebSocket = upstream;
  ws.binaryType = 'arraybuffer';
  let closed = false;
  let receiver: ((data: Uint8Array) => Promise<void>) | undefined;
  let chain = Promise.resolve();
  let queued = 0;
  let uploaded = 0;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  function close() {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    try { ws.close(1000, 'RDP closed'); } catch { /* already closed */ }
    resolveDone();
  }
  function fail() {
    rejectDone(new Error('tunnel_closed'));
    close();
  }
  ws.addEventListener('message', ({ data }) => {
    if (closed) return;
    if (!(data instanceof ArrayBuffer) || !data.byteLength || queued + data.byteLength > RDP_WINDOW || !receiver) return fail();
    queued += data.byteLength;
    chain = chain.then(async () => {
      if (!closed) await receiver?.(new Uint8Array(data));
    }).catch(fail).finally(() => { queued -= data.byteLength; });
  });
  ws.addEventListener('close', () => { void chain.finally(close); });
  ws.addEventListener('error', fail);
  signal.addEventListener('abort', close, { once: true });
  ws.accept();
  if (signal.aborted) { close(); signal.throwIfAborted(); }
  return {
    read(deliver) { receiver = deliver; return done; },
    async write(data) {
      if (closed || data.length > RDP_FRAME || uploaded + data.length > MAX_TUNNEL_UPLOAD) {
        throw new Error('tunnel_write_limit');
      }
      uploaded += data.length;
      // Cloudflared uses a 16 KiB per-message copy buffer. This is the TLS byte stream, not RDP PDUs.
      ws.send(data);
      // Worker WebSockets have no writable drain signal; rate limit the carrier ingress.
      if (data.length >= 1024) await new Promise(resolve => setTimeout(resolve, Math.ceil(data.length / 1024)));
    },
    close,
  };
}
