import { isRdpId } from '../rdp-schema';
import { PEER_PAIR_MS, PEER_PROTOCOL } from './rdp-peer-auth';

const TTL = 35_000,
  NEGOTIATE = 30_000,
  MAX_LIFE = 2 * 60 * 60_000;
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
interface Hooks {
  claim(
    user: number,
    ticket: string,
    binding: string
  ): Promise<{ lease: string; profile: string; revision: number } | null>;
  record(user: number, lease: string): boolean;
  renew(user: number, lease: string): boolean;
  release(user: number, lease: string): void;
}
interface Room {
  user: number;
  id: string;
  revision: number;
  binding: string;
  proof: string;
  agent: WebSocket;
  browser?: WebSocket;
  lease?: string;
  stage: 'waiting' | 'offer' | 'answer' | 'opening' | 'live';
  timer?: ReturnType<typeof setTimeout>;
  hardEnd: number;
  lastInput: number;
  idleMs: number;
  lastRenew: number;
  recorded: boolean;
}

/** The account DO pairs two CONTROL sockets. No SDP, addresses, or Windows bytes are persisted.
 * An eviction/restart of a live room fails closed; the connector also owns an independent deadline. */
export class RdpPeerRooms {
  private rooms = new Map<string, Room>();
  private pending = 0;
  constructor(
    private sql: SqlStorage,
    private hooks: Hooks
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS rdp_peer_pairs(user_id INTEGER NOT NULL, profile TEXT NOT NULL,
      revision INTEGER NOT NULL, binding TEXT NOT NULL, proof TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(user_id,profile))`);
  }
  invalidate(user: number, id: string) {
    this.sql.exec('DELETE FROM rdp_peer_pairs WHERE user_id=? AND profile=?', user, id);
    const room = this.rooms.get(id);
    if (room?.user === user) this.end(room, 'lease_ended');
  }
  prepare(user: number, id: string, revision: number, binding: string, proof: string) {
    const now = Date.now();
    this.sql.exec('DELETE FROM rdp_peer_pairs WHERE expires<=?', now);
    // Re-pairing never evicts an active or waiting connector.
    if (this.rooms.has(id)) return deny();
    const inserted = this.sql.exec(
      `INSERT INTO rdp_peer_pairs SELECT user_id,id,revision,?,?,? FROM rdp_profiles
      WHERE user_id=? AND id=? AND revision=? AND length(fingerprint)=64 AND EXISTS
      (SELECT 1 FROM rdp_profile_options o WHERE o.user_id=? AND o.profile=? AND o.login IS NOT NULL)
      ON CONFLICT(user_id,profile) DO UPDATE SET revision=excluded.revision,binding=excluded.binding,proof=excluded.proof,expires=excluded.expires`,
      binding,
      proof,
      now + PEER_PAIR_MS,
      user,
      id,
      revision,
      user,
      id
    );
    return inserted.rowsWritten ? Response.json({ ok: true }) : deny();
  }
  cancelWaiting(user: number, id: string, binding: string, proof: string) {
    this.sql.exec(
      'DELETE FROM rdp_peer_pairs WHERE user_id=? AND profile=? AND binding=? AND proof=?',
      user,
      id,
      binding,
      proof
    );
    const r = this.rooms.get(id);
    if (r?.stage === 'waiting' && r.user === user && r.binding === binding && r.proof === proof)
      this.end(r, 'peer_ended');
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  agent(user: number, id: string, proof: string): Response {
    if (this.rooms.has(id) || this.rooms.size >= 4) return deny();
    const row = this.sql
      .exec(
        `SELECT b.binding,b.revision FROM rdp_peer_pairs b JOIN rdp_profiles p
      ON b.profile=p.id AND b.user_id=p.user_id AND b.revision=p.revision WHERE b.user_id=? AND b.profile=? AND b.proof=? AND b.expires>?`,
        user,
        id,
        proof,
        Date.now()
      )
      .toArray()[0];
    if (!row) return deny(401);
    this.sql.exec('DELETE FROM rdp_peer_pairs WHERE user_id=? AND profile=?', user, id);
    const { ws, response } = pair();
    const r: Room = {
      user,
      id,
      proof,
      revision: Number(row.revision),
      binding: String(row.binding),
      agent: ws,
      stage: 'waiting',
      hardEnd: 0,
      lastInput: 0,
      idleMs: 0,
      lastRenew: 0,
      recorded: false,
    };
    this.rooms.set(id, r);
    this.deadline(r, PEER_PAIR_MS, 'peer_timeout');
    ws.addEventListener('close', () => this.end(r, 'peer_ended'));
    ws.addEventListener('error', () => this.end(r, 'peer_ended'));
    ws.addEventListener('message', ({ data }) => {
      if (this.rooms.get(id) !== r) return;
      try {
        const m = this.message(data);
        if (r.stage === 'answer' && m.type === 'answer' && peerSdp(m.sdp)) {
          r.stage = 'opening';
          send(r.browser!, { type: 'answer', sdp: m.sdp });
        } else if (r.stage === 'opening' && m.type === 'connected') {
          r.stage = 'live';
          this.liveDeadline(r);
        } else this.end(r, 'peer_failed');
      } catch {
        this.end(r, 'peer_failed');
      }
    });
    send(ws, { type: 'waiting' });
    return response;
  }
  browser(user: number, binding: string, idleMs: number): Response {
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
    ws.addEventListener('error', () => stop('peer_ended'));
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
        if (
          !claimed &&
          m.type === 'ticket' &&
          typeof m.ticket === 'string' &&
          /^[0-9a-f]{64}$/.test(m.ticket)
        ) {
          claimed = true;
          const result = await this.hooks.claim(user, m.ticket, binding);
          if (!result) return stop('ticket_rejected');
          const room = this.rooms.get(result.profile);
          if (
            finished ||
            !room ||
            room.stage !== 'waiting' ||
            room.user !== user ||
            room.binding !== binding ||
            room.revision !== result.revision
          ) {
            this.hooks.release(user, result.lease);
            return stop('peer_unavailable');
          }
          r = room;
          r.browser = ws;
          r.lease = result.lease;
          r.stage = 'offer';
          r.idleMs = idleMs;
          r.lastRenew = r.lastInput = Date.now();
          r.hardEnd = r.lastRenew + MAX_LIFE;
          clearTimeout(timer);
          uncount();
          this.deadline(r, NEGOTIATE, 'peer_timeout');
          send(r.agent, { type: 'lease', until: r.lastRenew + TTL });
          send(ws, { type: 'paired', lease: r.lease });
        } else if (r?.stage === 'offer' && m.type === 'offer' && peerSdp(m.sdp)) {
          r.stage = 'answer';
          send(r.agent, { type: 'offer', sdp: m.sdp });
        } else if (r && m.type === 'activity' && (r.stage === 'opening' || r.stage === 'live')) {
          if (r.idleMs && now >= r.lastInput + r.idleMs) return stop('idle_timeout');
          r.lastInput = now;
          if (r.stage === 'live') this.liveDeadline(r);
        } else if (
          r &&
          r.lease &&
          m.type === 'desktop_ready' &&
          (r.stage === 'live' || r.stage === 'opening') &&
          !r.recorded
        ) {
          r.recorded = true;
          if (this.hooks.record(user, r.lease)) send(ws, { type: 'desktop_recorded' });
        } else stop('peer_failed');
      })().catch(() => stop('peer_failed'));
    });
    return response;
  }
  renew(user: number, id: string, lease: unknown, binding: string): Response {
    const r = this.rooms.get(id),
      now = Date.now();
    if (!r || !isRdpId(lease) || r.user !== user || r.binding !== binding || r.lease !== lease)
      return deny();
    if (
      now >= r.hardEnd ||
      now >= r.lastRenew + TTL ||
      (r.idleMs && now >= r.lastInput + r.idleMs) ||
      !this.hooks.renew(user, lease)
    ) {
      this.end(r, 'lease_ended');
      return deny();
    }
    r.lastRenew = now;
    try {
      send(r.agent, { type: 'lease', until: Math.min(now + TTL, r.hardEnd) });
    } catch {
      this.end(r, 'lease_ended');
      return deny();
    }
    if (r.stage === 'live') this.liveDeadline(r);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  private message(data: unknown) {
    if (typeof data !== 'string' || data.length > 14_000) throw new Error('invalid control');
    return JSON.parse(data) as Record<string, unknown>;
  }
  private deadline(r: Room, ms: number, reason: string) {
    if (r.timer !== undefined) clearTimeout(r.timer);
    r.timer = setTimeout(() => this.end(r, reason), Math.max(0, ms));
  }
  private liveDeadline(r: Room) {
    const idle = r.idleMs ? r.lastInput + r.idleMs : Infinity;
    const until = Math.min(r.hardEnd, r.lastRenew + TTL, idle);
    this.deadline(
      r,
      until - Date.now(),
      until === idle ? 'idle_timeout' : until === r.hardEnd ? 'session_limit' : 'lease_ended'
    );
  }
  private end(r: Room, reason: string) {
    if (this.rooms.get(r.id) !== r) return;
    this.rooms.delete(r.id);
    if (r.timer !== undefined) clearTimeout(r.timer);
    close(r.agent, reason);
    close(r.browser, reason);
    if (r.lease) this.hooks.release(r.user, r.lease);
  }
}
