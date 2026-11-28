import { RDP_FRAME, RDP_WINDOW, RDP_WS_PROTOCOL } from '../rdp-schema';
import { RdpDirectDnsError } from './rdp-direct-dns';
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

const CERT_WAIT_MS = 90_000;
const CERT_HOLD_GRACE_MS = 5_000;

type UpstreamEnd = 'upstream_closed' | 'upstream_read_failed' | 'upstream_write_failed';

// All three cursors are offsets in the *outbound* TCP stream. Tag each non-empty read
// with the write in progress when read() returned; draining an older blocked chunk later
// must not turn it into a new read. No RDP contents, additional reads or TCP probes.
interface BindingReturn {
  writing: number;
  readAt: number;
  forwardedAt: number;
  watch?: { end: number; at: number; samples: number };
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
  let certificate: 'pending' | 'waiting' | 'resolved' = 'resolved';
  let upstreamClosed = false;
  let lastProbe = -Infinity;
  let creditWake: (() => void) | undefined;
  let writes = Promise.resolve();
  let bindingReturn: BindingReturn | undefined;
  let certTimer: ReturnType<typeof setTimeout> | undefined;
  let phaseTimer = setTimeout(() => finish(1008, 'ticket_timeout'), 5000);
  // Two internal requests per 15 s renewal stay below the Workers Free 1,000-request
  // invocation budget over two hours, including claim/initial authentication and release.
  const life = setTimeout(() => finish(1000, 'session_limit'), 2 * 60 * 60 * 1000);
  const monitor = setInterval(() => {
    const now = Date.now();
    if (stage !== 'ready') return;
    if (certificate !== 'waiting' && !upstreamClosed && hooks.idleMs && now - lastActivity >= hooks.idleMs) return finish(1000, 'idle_timeout');
    if (certificate !== 'waiting' && !upstreamClosed && ((inSent > inAck && now - lastInputProgress >= 30_000) ||
        (outSent > outAck && now - lastOutputProgress >= 30_000))) return finish(1008, 'slow_connection');
    if (now - lastRenew >= 40_000) return finish(1000, 'lease_ended');
    controls = 0;
    if (!renewing && lease && now - lastRenew >= 15_000) {
      renewing = true;
      void hooks.renew(lease.id).then(ok => {
        if (!ok) finish(1000, 'lease_ended');
        else {
          lastRenew = Date.now();
          sampleBindingReturn(lastRenew);
        }
      }, () => finish(1000, 'lease_ended')).finally(() => { renewing = false; });
    }
  }, 1000);

  function sampleBindingReturn(now: number) {
    const trace = bindingReturn, watch = trace?.watch;
    if (!trace || !watch || inAck < watch.end || stage !== 'ready' || certificate === 'waiting') return;
    const seconds = Math.max(0, Math.floor((now - watch.at) / 1000));
    if (seconds > 90) { bindingReturn = undefined; return; }
    const state = trace.forwardedAt >= watch.end ? 'forwarded'
      : trace.readAt >= watch.end ? (creditWake ? 'read_window' : 'read')
      : creditWake ? 'prior_window' : 'no_read';
    // Only on an already successful lease renewal. Not a sample at the native deadline.
    try { control({ type: 'binding_return', bytes: watch.end, state, seconds }); } catch { /* best effort */ }
    if (++watch.samples >= 4) bindingReturn = undefined;
  }
  function clearCertTimer() {
    if (certTimer !== undefined) {
      clearTimeout(certTimer);
      certTimer = undefined;
    }
  }
  function release(id: string) {
    const result = hooks.release(id).catch(() => {});
    hooks.waitUntil?.(result);
  }
  function finish(code: number, reason: string) {
    if (stage === 'closed') return;
    stage = 'closed';
    bindingReturn = undefined;
    clearTimeout(life);
    clearTimeout(phaseTimer);
    clearCertTimer();
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
  function endUpstream(reason: UpstreamEnd) {
    if (stage !== 'ready' || upstreamClosed) return;
    const code = reason === 'upstream_closed' ? 1000 : 1011;
    // TLS bytes can reach the browser just before the remote closes. Allow a short,
    // bounded grace period for its cert_wait, even if a write detects the close first.
    if (certificate !== 'waiting' && !(certificate === 'pending' && outSent > 0)) {
      return finish(code, reason);
    }
    upstreamClosed = true;
    bindingReturn = undefined;
    const closed = transport;
    transport = undefined; // A write aborted by close must not tear down the held lease.
    creditWake?.();
    creditWake = undefined;
    closed?.close();
    try { control({ type: 'cert_hold' }); } catch { return finish(1011, 'session_ended'); }
    if (certificate !== 'waiting') {
      certTimer = setTimeout(() => finish(code, reason), CERT_HOLD_GRACE_MS);
    }
  }
  async function deliver(data: Uint8Array): Promise<void> {
    const trace = bindingReturn;
    const readAt = trace?.writing ?? 0;
    if (trace && data.length) trace.readAt = readAt;
    for (let offset = 0; offset < data.length; offset += RDP_FRAME) {
      const frame = data.subarray(offset, offset + RDP_FRAME);
      while (stage === 'ready' && !upstreamClosed && outSent - outAck + frame.length > RDP_WINDOW) {
        await new Promise<void>(resolve => { creditWake = resolve; });
      }
      if (stage !== 'ready' || upstreamClosed) return;
      if (outSent === outAck) lastOutputProgress = Date.now();
      outSent += frame.length;
      ws.send(frame);
      if (trace && offset === 0) trace.forwardedAt = readAt;
    }
  }
  async function establish(ticket: string, certRotation: boolean, returnSamples: boolean) {
    stage = 'opening';
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => finish(1011, 'connect_timeout'), 10_000);
    try {
      const claimed = await hooks.claim(ticket);
      if (!claimed) return finish(1008, 'ticket_rejected');
      if (abort.signal.aborted) return release(claimed.id);
      lease = claimed;
      // A stored pin is not evidence that it matched this TLS handshake. New clients may
      // need the same bounded pre-frame hold for an explicitly confirmed certificate change.
      certificate = claimed.profile.fingerprint === null || certRotation ? 'pending' : 'resolved';
      transport = await openRdpTransport(claimed, abort.signal);
      if (abort.signal.aborted) return transport.close();
      if (!(await hooks.renew(claimed.id).catch(() => false)) || abort.signal.aborted) {
        return finish(1000, 'lease_ended');
      }
      clearTimeout(phaseTimer);
      lastInputProgress = lastOutputProgress = lastActivity = lastRenew = Date.now();
      stage = 'ready';
      if (returnSamples && claimed.profile.route === 'direct') bindingReturn = { writing: 0, readAt: 0, forwardedAt: 0 };
      control({ type: 'ready', lease: claimed.id, desktopReport: true, bindingReturn: bindingReturn ? true : undefined });
      try {
        await transport.read(deliver);
      } catch {
        return endUpstream('upstream_read_failed');
      }
      endUpstream('upstream_closed');
    } catch (err) {
      finish(1011, err instanceof RdpDirectDnsError ? err.code : 'upstream_unavailable');
    }
  }

  ws.addEventListener('message', ({ data }) => {
    if (stage === 'closed') return;
    try {
      if (typeof data === 'string') {
        if (data.length > 256 || ++controls > 256) return finish(1008, 'invalid_frame');
        const msg = JSON.parse(data);
        if (stage === 'ticket' && msg?.type === 'ticket' && typeof msg.ticket === 'string' && /^[a-f0-9]{64}$/.test(msg.ticket)) {
          void establish(msg.ticket, msg.certRotation === true, msg.bindingReturn === true);
          return;
        }
        if (stage !== 'ready') return finish(1008, 'invalid_frame');
        if (msg?.type === 'binding_watch') {
          // Ordered after the final binding slice on this WebSocket. A stale, duplicate or
          // unsupported observation neither affects the live stream nor refreshes any clock.
          if (bindingReturn && !bindingReturn.watch && certificate !== 'waiting' &&
              Number.isSafeInteger(msg.bytes) && msg.bytes > 0 && msg.bytes === inSent) {
            bindingReturn.watch = { end: inSent, at: Date.now(), samples: 0 };
          }
          return;
        }
        if (msg?.type === 'cert_wait') {
          if (certificate === 'resolved') return finish(1008, 'invalid_frame');
          if (certificate === 'pending') {
            certificate = 'waiting';
            clearCertTimer();
            certTimer = setTimeout(() => finish(1000, 'cert_timeout'), CERT_WAIT_MS);
          }
          return;
        }
        if (msg?.type === 'cert_done') {
          if (certificate !== 'waiting') return finish(1008, 'invalid_frame');
          certificate = 'resolved';
          clearCertTimer();
          lastInputProgress = lastOutputProgress = lastActivity = Date.now();
          if (upstreamClosed) finish(1000, 'cert_reconnect');
          return;
        }
        if (msg?.type === 'desktop_ready' && lease) {
          if (reportedDesktop) return;
          if (upstreamClosed || certificate === 'waiting') return finish(1008, 'invalid_frame');
          reportedDesktop = true;
          bindingReturn = undefined;
          certificate = 'resolved';
          clearCertTimer();
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
      if (upstreamClosed) return;
      if (inSent === inAck) lastInputProgress = Date.now();
      inSent += data.byteLength;
      writes = writes.then(async () => {
        const active = transport;
        if (stage !== 'ready' || !active) return;
        if (bindingReturn) bindingReturn.writing = inAck + data.byteLength;
        try { await active.write(new Uint8Array(data)); }
        catch { return endUpstream('upstream_write_failed'); }
        if (stage !== 'ready' || transport !== active) return;
        inAck += data.byteLength;
        lastInputProgress = Date.now();
        control({ type: 'ack', bytes: inAck });
      }).catch(() => finish(1011, 'session_ended'));
    } catch { finish(1008, 'invalid_frame'); }
  });
  ws.addEventListener('close', () => finish(1000, 'session_ended'));
  ws.addEventListener('error', () => finish(1011, 'session_ended'));
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': RDP_WS_PROTOCOL } });
}
