import { isRdpId } from '../rdp-schema';
import { digestHex, PEER_PROTOCOL, randomProof } from './rdp-device-auth';

const TTL = 35_000;
const NEGOTIATE = 23_000;
const MAX_LIFE = 2 * 60 * 60_000;
const deny = (status = 409) =>
  Response.json({ code: 'peer_unavailable' }, { status, headers: { 'Cache-Control': 'no-store' } });
const send = (ws: WebSocket, data: object) => ws.send(JSON.stringify(data));
const close = (ws: WebSocket | undefined, reason: string) => {
  try {
    ws?.close(1000, reason);
  } catch {
    /* already closed */
  }
};
function pair() {
  const [client, ws] = Object.values(new WebSocketPair());
  ws.accept();
  return {
    ws,
    response: new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': PEER_PROTOCOL },
    }),
  };
}
export function peerSdp(sdp: unknown): sdp is string {
  return (
    typeof sdp === 'string' &&
    sdp.length <= 12_288 &&
    sdp.startsWith('v=0\r\n') &&
    !/[^\x20-\x7e\r\n\t]/.test(sdp) &&
    /^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel\r?$/m.test(sdp) &&
    sdp.match(/^m=/gm)?.length === 1 &&
    (sdp.match(/^a=candidate:/gm)?.length ?? 0) <= 64 &&
    !/^a=candidate:[^\r\n]+ typ relay\b/m.test(sdp) &&
    /^a=fingerprint:sha-256 /im.test(sdp)
  );
}
interface Claimed {
  lease: string;
  profile: string;
  revision: number;
  device: string;
}
interface Hooks {
  claim(user: number, ticket: string, binding: string, origin: string): Promise<Claimed | null>;
  invite(
    user: number,
    profile: string,
    revision: number,
    origin: string,
    device: string,
    proof: string
  ): boolean;
  record(user: number, lease: string): boolean;
  renew(user: number, lease: string): boolean;
  release(user: number, lease: string): void;
}
interface Room {
  user: number;
  id: string;
  origin: string;
  device: string;
  binding: string;
  lease: string;
  proof?: string;
  agent?: WebSocket;
  browser: WebSocket;
  stage: 'attach' | 'offer' | 'answer' | 'opening' | 'live';
  timer?: ReturnType<typeof setTimeout>;
  hardEnd: number;
  lastInput: number;
  idleMs: number;
  lastRenew: number;
  recorded: boolean;
  cert: 'none' | 'waiting' | 'done';
  certUntil: number;
}

/** The standby socket can hibernate. Each authorized desktop has separate, short-lived control sockets.
 * No SDP, addresses, session proofs or Windows bytes are persisted. Restarting a room fails closed. */
export class RdpPeerRooms {
  private rooms = new Map<string, Room>();
  private pending = 0;
  constructor(private readonly hooks: Hooks) {}
  invalidate(user: number, id: string) {
    const room = this.rooms.get(id);
    if (room?.user === user) this.end(room, 'lease_ended');
  }
  agent(user: number, id: string, device: string, origin: string, proof: string): Response {
    const r = this.rooms.get(id);
    if (
      r?.stage !== 'attach' ||
      r.user !== user ||
      r.device !== device ||
      r.origin !== origin ||
      r.proof !== proof
    )
      return deny(401);
    r.proof = undefined;
    const { ws, response } = pair();
    r.agent = ws;
    ws.addEventListener('close', () => this.end(r, 'peer_ended'));
    ws.addEventListener('error', () => this.end(r, 'peer_failed'));
    ws.addEventListener('message', ({ data }) => {
      if (this.rooms.get(id) !== r) return;
      try {
        const m = this.message(data);
        if (r.stage === 'answer' && m.type === 'answer' && peerSdp(m.sdp)) {
          r.stage = 'opening';
          send(r.browser, { type: 'answer', sdp: m.sdp });
        } else if (r.stage === 'opening' && m.type === 'connected') {
          r.stage = 'live';
          this.liveDeadline(r);
        } else this.end(r, 'peer_failed');
      } catch {
        this.end(r, 'peer_failed');
      }
    });
    r.stage = 'offer';
    try {
      send(ws, { type: 'lease', until: Math.min(r.lastRenew + TTL, r.hardEnd) });
      send(r.browser, { type: 'paired', lease: r.lease });
    } catch {
      this.end(r, 'peer_failed');
    }
    return response;
  }
  browser(user: number, binding: string, idleMs: number, origin: string): Response {
    if (this.pending >= 4) return deny(429);
    const { ws, response } = pair();
    let r: Room | undefined,
      finished = false,
      claimed = false,
      counted = true;
    this.pending++;
    const uncount = () => {
      if (counted) {
        counted = false;
        this.pending--;
      }
    };
    const timer = setTimeout(() => stop('ticket_rejected'), 5000);
    const stop = (reason: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      uncount();
      if (r) this.end(r, reason);
      else close(ws, reason);
    };
    ws.addEventListener('close', () => stop('peer_ended'));
    ws.addEventListener('error', () => stop('peer_failed'));
    let controls = 0,
      since = Date.now();
    ws.addEventListener('message', ({ data }) => {
      void (async () => {
        if (finished) return;
        if (r && this.rooms.get(r.id) !== r) return stop('peer_ended');
        const now = Date.now();
        if (now - since >= 1000) {
          since = now;
          controls = 0;
        }
        if (++controls > 6) return stop('peer_failed');
        const m = this.message(data);
        if (!claimed && m.type === 'ticket' && digestHex(m.ticket)) {
          claimed = true;
          const result = await this.hooks.claim(user, m.ticket, binding, origin);
          if (!result) return stop('ticket_rejected');
          const concurrent = this.rooms.has(result.profile);
          if (finished || concurrent || this.rooms.size >= 4) {
            this.hooks.release(user, result.lease);
            return stop(concurrent ? 'peer_busy' : 'peer_unavailable');
          }
          const proof = randomProof();
          const { device } = result;
          if (!this.hooks.invite(user, result.profile, result.revision, origin, device, proof)) {
            this.hooks.release(user, result.lease);
            return stop('peer_unavailable');
          }
          const start = Date.now();
          r = {
            user,
            id: result.profile,
            origin,
            device,
            binding,
            lease: result.lease,
            proof,
            browser: ws,
            stage: 'attach',
            hardEnd: start + MAX_LIFE,
            lastInput: start,
            idleMs,
            lastRenew: start,
            recorded: false,
            cert: 'none',
            certUntil: Infinity,
          };
          this.rooms.set(r.id, r);
          clearTimeout(timer);
          uncount();
          this.deadline(r, NEGOTIATE, 'peer_timeout');
          return;
        }
        if (!r) return stop('peer_failed');
        if (r.stage === 'offer' && r.agent && m.type === 'offer' && peerSdp(m.sdp)) {
          r.stage = 'answer';
          send(r.agent, { type: 'offer', sdp: m.sdp });
          return;
        }
        if (r.stage !== 'opening' && r.stage !== 'live') return stop('peer_failed');
        if (m.type === 'activity') {
          if (r.idleMs && now >= r.lastInput + r.idleMs) return stop('idle_timeout');
          r.lastInput = now;
        } else if (m.type === 'desktop_ready' && !r.recorded && r.cert !== 'waiting') {
          r.recorded = true;
          if (this.hooks.record(user, r.lease)) send(ws, { type: 'desktop_recorded' });
        } else if (m.type === 'cert_wait' && r.cert === 'none' && !r.recorded) {
          r.cert = 'waiting';
          r.certUntil = now + 90_000;
        } else if (m.type === 'cert_done' && r.cert === 'waiting' && now < r.certUntil) {
          r.cert = 'done';
          r.certUntil = Infinity;
        } else return stop('peer_failed');
        if (r.stage === 'live') this.liveDeadline(r);
      })().catch(() => stop('peer_failed'));
    });
    return response;
  }
  renew(user: number, id: string, lease: unknown, binding: string, origin: string): Response {
    const r = this.rooms.get(id),
      now = Date.now();
    if (
      !r?.agent ||
      !isRdpId(lease) ||
      r.user !== user ||
      r.origin !== origin ||
      r.binding !== binding ||
      r.lease !== lease
    )
      return deny();
    if (
      now >= r.hardEnd ||
      now >= r.lastRenew + TTL ||
      now >= r.certUntil ||
      (r.idleMs && now >= r.lastInput + r.idleMs) ||
      !this.hooks.renew(user, lease)
    ) {
      this.end(r, 'lease_ended');
      return deny();
    }
    r.lastRenew = now;
    try {
      send(r.agent, { type: 'lease', until: Math.min(now + TTL, r.hardEnd, r.certUntil) });
    } catch {
      this.end(r, 'lease_ended');
      return deny();
    }
    if (r.stage === 'live') this.liveDeadline(r);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  private message(data: unknown): Record<string, unknown> {
    if (typeof data !== 'string' || data.length > 14_000) throw new Error('invalid control');
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid control');
    return value as Record<string, unknown>;
  }
  private deadline(r: Room, ms: number, reason: string) {
    if (r.timer !== undefined) clearTimeout(r.timer);
    r.timer = setTimeout(() => this.end(r, reason), Math.max(0, ms));
  }
  private liveDeadline(r: Room) {
    const idle = r.idleMs ? r.lastInput + r.idleMs : Infinity;
    const until = Math.min(r.hardEnd, r.lastRenew + TTL, idle, r.certUntil);
    let reason = 'lease_ended';
    if (until === r.certUntil) reason = 'cert_timeout';
    else if (until === idle) reason = 'idle_timeout';
    else if (until === r.hardEnd) reason = 'session_limit';
    this.deadline(r, until - Date.now(), reason);
  }
  private end(r: Room, reason: string) {
    if (this.rooms.get(r.id) !== r) return;
    this.rooms.delete(r.id);
    if (r.timer !== undefined) clearTimeout(r.timer);
    r.proof = undefined;
    close(r.agent, reason);
    close(r.browser, reason);
    this.hooks.release(r.user, r.lease);
  }
}
