import type { RdpConnector } from '../rdp-schema';
import {
  DEVICE_PING,
  DEVICE_PONG,
  ENROLL_MS,
  STANDBY_PROTOCOL,
  deviceKeyFingerprint,
  deviceLabel,
  digestHex,
  isDeviceKey,
  isDeviceSignature,
  randomProof,
  standbyMessage,
  verifyDeviceSignature,
} from './rdp-device-auth';

const challengeMs = 30_000;
const installVersion = 3;
const noStore = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const denied = (status = 409) => noStore({ code: 'connector_unavailable' }, status);
interface Attached {
  user: number;
  profile: string;
  device: string;
  origin: string;
}
interface DeviceRow {
  id: string;
  key: string;
  label: string;
  origin: string;
  fingerprint: string;
}
interface Enrollment {
  device: string;
  proof: string;
  expires: number;
  key: string | null;
  label: string;
  fingerprint: string;
}
const tag = (profile: string) => `rdp-device:${profile}`;

/** A device credential can maintain presence, never initiate desktop access or read saved credentials. */
export class RdpDevices {
  constructor(
    private readonly sql: SqlStorage,
    private readonly tx: <T>(cb: () => T) => T,
    private readonly state?: DurableObjectState
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS rdp_devices(user_id INTEGER NOT NULL, profile TEXT NOT NULL,
      id TEXT NOT NULL, origin TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, fingerprint TEXT NOT NULL,
      PRIMARY KEY(user_id,profile))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rdp_device_enrollments(user_id INTEGER NOT NULL, profile TEXT NOT NULL,
      revision INTEGER NOT NULL, origin TEXT NOT NULL, proof TEXT NOT NULL, expires INTEGER NOT NULL,
      device TEXT NOT NULL, key TEXT, label TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
      grant_version INTEGER NOT NULL DEFAULT 2, PRIMARY KEY(user_id,profile))`);
    if (
      !sql
        .exec('PRAGMA table_info(rdp_device_enrollments)')
        .toArray()
        .some((row) => row.name === 'grant_version')
    ) {
      sql.exec(
        'ALTER TABLE rdp_device_enrollments ADD COLUMN grant_version INTEGER NOT NULL DEFAULT 2'
      );
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS rdp_device_challenges(user_id INTEGER NOT NULL, profile TEXT NOT NULL,
      device TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(user_id, profile))`);
    if (state?.setWebSocketAutoResponse && typeof WebSocketRequestResponsePair === 'function') {
      state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(DEVICE_PING, DEVICE_PONG));
    }
  }
  private approved(user: number, profile: string) {
    return this.sql
      .exec(
        'SELECT id,key,label,origin,fingerprint FROM rdp_devices WHERE user_id=? AND profile=?',
        user,
        profile
      )
      .toArray()[0] as unknown as DeviceRow | undefined;
  }
  private pending(user: number, profile: string, origin: string): Enrollment | undefined {
    return this.sql
      .exec(
        `SELECT e.device,e.proof,e.expires,e.key,e.label,e.fingerprint FROM rdp_device_enrollments e JOIN rdp_profiles p
      ON p.user_id=e.user_id AND p.id=e.profile AND p.revision=e.revision
      WHERE e.user_id=? AND e.profile=? AND e.origin=? AND e.expires>? AND e.grant_version=?`,
        user,
        profile,
        origin,
        Date.now(),
        installVersion
      )
      .toArray()[0] as unknown as Enrollment | undefined;
  }
  private sockets(profile: string) {
    return this.state?.getWebSockets(tag(profile)) ?? [];
  }
  private online(
    user: number,
    profile: string,
    device: string,
    origin: string
  ): WebSocket | undefined {
    return this.sockets(profile).find((ws) => {
      if (ws.readyState !== 1) return false;
      const a = ws.deserializeAttachment() as Attached | null;
      return (
        a?.user === user && a.profile === profile && a.device === device && a.origin === origin
      );
    });
  }
  status(user: number, profile: string, origin: string): RdpConnector {
    const row = this.approved(user, profile);
    if (row) {
      if (row.origin !== origin) return { state: 'other_origin', origin: row.origin };
      return {
        state: this.online(user, profile, row.id, origin) ? 'online' : 'offline',
        label: row.label,
        fingerprint: row.fingerprint,
      };
    }
    const e = this.pending(user, profile, origin);
    return e ? { state: 'waiting', expires: e.expires } : { state: 'unbound' };
  }
  begin(
    user: number,
    profile: string,
    origin: string,
    revision: number,
    proof: string,
    expires: number
  ): Response {
    if (expires <= Date.now() || expires > Date.now() + ENROLL_MS) return denied();
    return this.tx(() => {
      this.sql.exec('DELETE FROM rdp_device_enrollments WHERE expires<=?', Date.now());
      if (this.approved(user, profile)) return denied(); // Only explicit unlink may replace an identity.
      const result = this.sql.exec(
        `INSERT INTO rdp_device_enrollments (user_id,profile,revision,origin,proof,expires,device,grant_version)
        SELECT p.user_id,p.id,p.revision,?,?,?,?,? FROM rdp_profiles p JOIN rdp_profile_options o ON p.user_id=o.user_id AND p.id=o.profile
        WHERE p.user_id=? AND p.id=? AND p.revision=? AND o.login IS NOT NULL
        ON CONFLICT(user_id,profile) DO UPDATE SET revision=excluded.revision,origin=excluded.origin,proof=excluded.proof,
          expires=excluded.expires,device=excluded.device,grant_version=excluded.grant_version,key=NULL,label='',fingerprint=''`,
        origin,
        proof,
        expires,
        crypto.randomUUID(),
        installVersion,
        user,
        profile,
        revision
      );
      return result.rowsWritten ? noStore({ ok: true }) : denied();
    });
  }
  async register(
    user: number,
    profile: string,
    origin: string,
    proof: string,
    key: string,
    label: string
  ): Promise<Response> {
    const fingerprint = await deviceKeyFingerprint(key);
    return this.tx(() => {
      const e = this.pending(user, profile, origin),
        bound = this.approved(user, profile);
      if (!e || e.proof !== proof || (bound && bound.id !== e.device)) return denied(401);
      // One key consumes the grant. The same key+label may recover a lost response, never another key.
      if (e.key && (e.key !== key || e.label !== label)) return denied(401);
      if (!e.key)
        this.sql.exec(
          'UPDATE rdp_device_enrollments SET key=?,label=?,fingerprint=? WHERE user_id=? AND profile=?',
          key,
          label,
          fingerprint,
          user,
          profile
        );
      return noStore({ device: e.device, fingerprint });
    });
  }
  private candidate(
    user: number,
    profile: string,
    device: string,
    origin: string
  ): DeviceRow | undefined {
    const bound = this.approved(user, profile);
    if (bound) return bound.id === device && bound.origin === origin ? bound : undefined;
    const e = this.pending(user, profile, origin);
    return e?.device === device && e.key
      ? { id: device, origin, key: e.key, label: e.label, fingerprint: e.fingerprint }
      : undefined;
  }
  clearPending(user: number, profile: string) {
    this.sql.exec(
      'DELETE FROM rdp_device_enrollments WHERE user_id=? AND profile=?',
      user,
      profile
    );
  }
  unlink(user: number, profile: string): void {
    this.clearPending(user, profile);
    this.sql.exec('DELETE FROM rdp_device_challenges WHERE user_id=? AND profile=?', user, profile);
    this.sql.exec('DELETE FROM rdp_devices WHERE user_id=? AND profile=?', user, profile);
    for (const ws of this.sockets(profile)) {
      if ((ws.deserializeAttachment() as Attached | null)?.user === user) {
        try {
          ws.close(1000, 'device_unlinked');
        } catch {
          /* already closed */
        }
      }
    }
  }
  matches(user: number, profile: string, device: string, origin: string): boolean {
    const row = this.approved(user, profile);
    return row?.id === device && row.origin === origin;
  }
  challenge(user: number, profile: string, device: string, origin: string): Response {
    return this.tx(() => {
      if (!this.candidate(user, profile, device, origin)) return denied(410);
      const current = this.sql
        .exec(
          `SELECT nonce FROM rdp_device_challenges WHERE user_id=? AND profile=? AND device=? AND expires>?`,
          user,
          profile,
          device,
          Date.now()
        )
        .toArray()[0];
      if (current) return noStore({ challenge: current.nonce });
      const challenge = randomProof();
      this.sql.exec(
        `INSERT INTO rdp_device_challenges VALUES (?,?,?,?,?) ON CONFLICT(user_id,profile)
        DO UPDATE SET device=excluded.device,nonce=excluded.nonce,expires=excluded.expires`,
        user,
        profile,
        device,
        challenge,
        Date.now() + challengeMs
      );
      return noStore({ challenge });
    });
  }
  async standby(
    user: number,
    profile: string,
    device: string,
    origin: string,
    nonce: string,
    signature: string,
    token: string
  ): Promise<Response> {
    const row = this.candidate(user, profile, device, origin);
    if (
      !this.state ||
      !row ||
      !digestHex(nonce) ||
      !isDeviceSignature(signature) ||
      !(await verifyDeviceSignature(row.key, signature, standbyMessage(token, nonce)))
    )
      return denied(401);
    return this.tx(() => {
      const current = this.candidate(user, profile, device, origin);
      if (!current || current.key !== row.key) return denied(401);
      const consumed = this.sql.exec(
        'DELETE FROM rdp_device_challenges WHERE user_id=? AND profile=? AND device=? AND nonce=? AND expires>?',
        user,
        profile,
        device,
        nonce,
        Date.now()
      );
      if (!consumed.rowsWritten) return denied(401);
      // Binding becomes durable only when the installed service proves the key. If installation failed
      // before standby, the owner can download a replacement package without a separate unlink step.
      if (!this.approved(user, profile))
        this.sql.exec(
          'INSERT INTO rdp_devices VALUES (?,?,?,?,?,?,?)',
          user,
          profile,
          device,
          origin,
          current.key,
          current.label,
          current.fingerprint
        );
      const previous = this.online(user, profile, device, origin);
      const [client, ws] = Object.values(new WebSocketPair());
      this.state!.acceptWebSocket(ws, [tag(profile)]);
      ws.serializeAttachment({ user, profile, device, origin } satisfies Attached);
      try {
        previous?.close(1000, 'replaced');
      } catch {
        /* already closed */
      }
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': STANDBY_PROTOCOL },
      });
    });
  }
  available(user: number, profile: string, origin: string): string | undefined {
    const row = this.approved(user, profile);
    return row?.origin === origin && this.online(user, profile, row.id, origin)
      ? row.id
      : undefined;
  }
  invite(user: number, profile: string, origin: string, device: string, proof: string): boolean {
    if (!this.matches(user, profile, device, origin)) return false;
    const socket = this.online(user, profile, device, origin);
    if (!socket) return false;
    try {
      socket.send(JSON.stringify({ type: 'connect', proof }));
      return true;
    } catch {
      return false;
    }
  }
  // No commands, control messages or binary input on standby. The sole heartbeat is answered by the runtime.
  static unexpected(ws: WebSocket): void {
    try {
      ws.close(1008, 'invalid_standby');
    } catch {
      /* already closed */
    }
  }
}

export function validRegistration(
  v: Record<string, unknown>
): v is { key: string; label: string; signature: string } {
  return isDeviceKey(v.key) && deviceLabel(v.label) && isDeviceSignature(v.signature);
}
