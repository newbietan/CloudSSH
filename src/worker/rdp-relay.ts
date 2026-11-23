import { RDP_FRAME, RDP_WINDOW, RDP_WS_PROTOCOL } from '../rdp-schema';
import type { RdpLease } from './rdp-store';
import { openRdpTransport, type RdpTransport } from './rdp-transport';

interface SessionHooks {
  claim(ticket: string): Promise<RdpLease | null>;
  desktopReady(lease: string): Promise<boolean>;
  renew(lease: string): Promise<boolean>;
  release(lease: string): Promise<void>;
  idleMs: number;
  waitUntil?: (task: Promise<unknown>) => void;
}

/** One ordered, binary socket per desktop. Control frames never enter the RDP/TLS stream. */
export function startRdpRelay(hooks: SessionHooks): Response {
  const [client, ws] = Object.values(new WebSocketPair());
  ws.binaryType = 'arraybuffer';
  ws.accept();
  const abort = new AbortController();
  let stage: 'ticket' | 'opening' | 'ready' | 'closed' = 'ticket';
  let lease: RdpLease | undefined;
  let transport: RdpTransport | undefined;
  let lastActivity = Date.now();
  let lastInputProgress = Date.now();
  let lastOutputProgress = Date.now();
  let lastRenew = Date.now();
  let renewing = false;
  let inSent = 0;
  let inAck = 0;
  let outSent = 0;
  let outAck = 0;
  let controls = 0;
  let reportedDesktop = false;
  let lastProbe = -Infinity;
  let creditWake: (() => void) | undefined;
  let writes = Promise.resolve();
  let phaseTimer = setTimeout(() => finish(1008, 'ticket_timeout'), 5000);
  // Two internal requests per 15 s renewal stay below the Workers Free 1,000-request
  // invocation budget over two hours, including claim/initial authentication and release.
  const life = setTimeout(() => finish(1000, 'session_limit'), 2 * 60 * 60 * 1000);
  const monitor = setInterval(() => {
    const now = Date.now();
    if (stage !== 'ready') return;
    if (hooks.idleMs && now - lastActivity >= hooks.idleMs) return finish(1000, 'idle_timeout');
    if ((inSent > inAck && now - lastInputProgress >= 30_000) ||
        (outSent > outAck && now - lastOutputProgress >= 30_000)) return finish(1008, 'slow_connection');
    if (now - lastRenew >= 40_000) return finish(1000, 'session_ended');
    controls = 0;
    if (!renewing && lease && now - lastRenew >= 15_000) {
      renewing = true;
      void hooks.renew(lease.id).then(ok => {
        if (!ok) finish(1000, 'session_ended');
        else lastRenew = Date.now();
      }, () => finish(1000, 'session_ended')).finally(() => { renewing = false; });
    }
  }, 1000);

  function release(id: string) {
    const result = hooks.release(id).catch(() => {});
    hooks.waitUntil?.(result);
  }
  function finish(code: number, reason: string) {
    if (stage === 'closed') return;
    stage = 'closed';
    clearTimeout(life);
    clearTimeout(phaseTimer);
    clearInterval(monitor);
    abort.abort();
    creditWake?.();
    creditWake = undefined;
    transport?.close();
    if (lease) release(lease.id);
    try { ws.close(code, reason); } catch { /* peer already closed */ }
  }
  function control(message: object) {
    if (stage !== 'closed') ws.send(JSON.stringify(message));
  }
  async function deliver(data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.length; offset += RDP_FRAME) {
      const frame = data.subarray(offset, offset + RDP_FRAME);
      while (stage === 'ready' && outSent - outAck + frame.length > RDP_WINDOW) {
        await new Promise<void>(resolve => { creditWake = resolve; });
      }
      if (stage !== 'ready') return;
      if (outSent === outAck) lastOutputProgress = Date.now();
      outSent += frame.length;
      ws.send(frame);
    }
  }
  async function establish(ticket: string) {
    stage = 'opening';
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => finish(1011, 'connect_timeout'), 10_000);
    try {
      const claimed = await hooks.claim(ticket);
      if (!claimed) return finish(1008, 'ticket_rejected');
      if (abort.signal.aborted) return release(claimed.id);
      lease = claimed;
      transport = await openRdpTransport(claimed, abort.signal);
      if (abort.signal.aborted) return transport.close();
      if (!(await hooks.renew(claimed.id)) || abort.signal.aborted) return finish(1000, 'session_ended');
      clearTimeout(phaseTimer);
      lastInputProgress = lastOutputProgress = lastActivity = lastRenew = Date.now();
      stage = 'ready';
      control({ type: 'ready', lease: claimed.id, desktopReport: true });
      await transport.read(deliver);
      finish(1000, 'session_ended');
    } catch { finish(1011, 'upstream_unavailable'); }
  }

  ws.addEventListener('message', ({ data }) => {
    if (stage === 'closed') return;
    try {
      if (typeof data === 'string') {
        if (data.length > 256 || ++controls > 256) return finish(1008, 'invalid_frame');
        const msg = JSON.parse(data);
        if (stage === 'ticket' && msg?.type === 'ticket' && typeof msg.ticket === 'string' && /^[a-f0-9]{64}$/.test(msg.ticket)) {
          void establish(msg.ticket);
          return;
        }
        if (stage !== 'ready') return finish(1008, 'invalid_frame');
        if (msg?.type === 'desktop_ready' && lease) {
          if (reportedDesktop) return;
          reportedDesktop = true;
          // Metadata is best-effort and once per live lease. Never block the byte stream or count activity.
          const write = hooks.desktopReady(lease.id).then(ok => { if (ok) control({ type: 'desktop_recorded' }); }).catch(() => {});
          hooks.waitUntil?.(write);
          return;
        }
        if (msg?.type === 'ping') {
          if (!Number.isSafeInteger(msg.id) || msg.id < 1 || msg.id > 0x7fffffff) return finish(1008, 'invalid_frame');
          const now = Date.now();
          if (now - lastProbe >= 1000) { lastProbe = now; control({ type: 'pong', id: msg.id }); }
          return; // Transport telemetry is neither Windows input nor user activity.
        }
        if (msg?.type === 'activity') { lastActivity = Date.now(); return; }
        if (msg?.type !== 'ack' || !Number.isSafeInteger(msg.bytes) || msg.bytes < outAck || msg.bytes > outSent) {
          return finish(1008, 'invalid_ack');
        }
        if (msg.bytes > outAck) {
          outAck = msg.bytes;
          lastOutputProgress = Date.now();
          creditWake?.();
          creditWake = undefined;
        }
        return;
      }
      if (stage !== 'ready' || !(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > RDP_FRAME || inSent - inAck + data.byteLength > RDP_WINDOW) {
        return finish(1008, 'invalid_frame');
      }
      if (inSent === inAck) lastInputProgress = Date.now();
      inSent += data.byteLength;
      writes = writes.then(async () => {
        if (stage !== 'ready' || !transport) return;
        await transport.write(new Uint8Array(data));
        inAck += data.byteLength;
        lastInputProgress = Date.now();
        control({ type: 'ack', bytes: inAck });
      }).catch(() => finish(1011, 'upstream_write_failed'));
    } catch { finish(1008, 'invalid_frame'); }
  });
  ws.addEventListener('close', () => finish(1000, 'session_ended'));
  ws.addEventListener('error', () => finish(1011, 'session_ended'));
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': RDP_WS_PROTOCOL } });
}
