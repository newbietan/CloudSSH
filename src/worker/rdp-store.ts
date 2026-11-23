import {
  type RdpProfile, type RdpRoute, RDP_MAX_PROFILES, isRdpId, parseRdpProfile, readRdpJson,
} from '../rdp-schema';

const TICKET_MS = 30_000;
export const RDP_LEASE_MS = 45_000;
const MAX_TICKETS = 8;
const MAX_SESSIONS = 2;
interface Row {
  id: string;
  revision: number;
  name: string;
  route: RdpRoute;
  host: string;
  fingerprint: string;
  access: string | null;
}
interface TicketRow { profile: string; revision: number; binding: string; expires: number }
export interface RdpLease { id: string; profile: RdpProfile; accessId?: string; accessSecret?: string }

export const rdpJson = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});
const error = (status: number, code: string) => rdpJson({ code }, status);
const profile = ({ id, revision, name, route, host, fingerprint, access }: Row): RdpProfile => ({
  id, revision, name, route, host, fingerprint, hasAccessToken: !!access,
});
const digestPattern = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function rdpDigest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Internal to the account UserDB. All row operations are scoped to the verified user. */
export class RdpStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(callback: () => T) => T,
    private readonly encrypt: (value: string, userId: number) => Promise<string>,
    private readonly decrypt: (value: string, userId: number) => Promise<string>,
  ) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rdp_profiles (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL,
      route TEXT NOT NULL, host TEXT NOT NULL, fingerprint TEXT NOT NULL, access TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rdp_tickets (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, profile TEXT NOT NULL, revision INTEGER NOT NULL,
      binding TEXT NOT NULL, expires INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rdp_leases (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, profile TEXT NOT NULL, revision INTEGER NOT NULL,
      expires INTEGER NOT NULL
    )`);
  }
  private row(userId: number, id: string): Row | undefined {
    return this.sql.exec('SELECT * FROM rdp_profiles WHERE user_id = ? AND id = ?', userId, id).toArray()[0] as unknown as Row | undefined;
  }
  private clean(now: number): void {
    this.sql.exec('DELETE FROM rdp_tickets WHERE expires <= ?', now);
    this.sql.exec('DELETE FROM rdp_leases WHERE expires <= ?', now);
  }
  private count(kind: 'rdp_profiles' | 'rdp_tickets' | 'rdp_leases', userId: number): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS count FROM ${kind} WHERE user_id = ?`, userId).one().count);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = Number(url.searchParams.get('user_id'));
    if (!Number.isSafeInteger(userId) || userId < 1) return error(400, 'invalid_request');
    const route = url.pathname.slice('/internal/rdp/'.length);
    if (route === 'profiles') {
      if (request.method === 'GET') {
        const rows = this.sql.exec('SELECT * FROM rdp_profiles WHERE user_id = ? ORDER BY name, id LIMIT ?', userId, RDP_MAX_PROFILES).toArray() as unknown as Row[];
        return rdpJson({ profiles: rows.map(profile) });
      }
      if (request.method === 'POST') return this.save(userId, null, await readRdpJson(request));
    }
    const [kind, id] = route.split('/');
    if (kind === 'profiles' && isRdpId(id) && route === `profiles/${id}`) {
      const row = this.row(userId, id);
      if (!row) return error(404, 'not_found');
      if (request.method === 'GET') return rdpJson(profile(row));
      if (request.method === 'PUT') return this.save(userId, row, await readRdpJson(request));
      if (request.method === 'DELETE') {
        this.transaction(() => {
          this.sql.exec('DELETE FROM rdp_profiles WHERE user_id = ? AND id = ?', userId, id);
          this.sql.exec('DELETE FROM rdp_tickets WHERE user_id = ? AND profile = ?', userId, id);
          this.sql.exec('DELETE FROM rdp_leases WHERE user_id = ? AND profile = ?', userId, id);
        });
        return rdpJson({ success: true });
      }
    }
    if (request.method !== 'POST') return error(405, 'method_not_allowed');
    const body = await readRdpJson(request) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return error(400, 'invalid_request');
    if (route === 'ticket' && isRdpId(body.profile) && digestPattern(body.binding)) {
      return this.issue(userId, body.profile, body.binding);
    }
    if (route === 'claim' && digestPattern(body.ticket) && digestPattern(body.binding)) {
      return this.claim(userId, body.ticket, body.binding);
    }
    if ((route === 'renew' || route === 'release') && isRdpId(body.lease)) {
      if (route === 'release') {
        this.sql.exec('DELETE FROM rdp_leases WHERE user_id = ? AND id = ?', userId, body.lease);
        return rdpJson({ success: true });
      }
      const now = Date.now();
      const result = this.sql.exec(`UPDATE rdp_leases SET expires = ? WHERE user_id = ? AND id = ? AND expires > ?
        AND EXISTS (SELECT 1 FROM rdp_profiles p WHERE p.user_id = rdp_leases.user_id
          AND p.id = rdp_leases.profile AND p.revision = rdp_leases.revision)`, now + RDP_LEASE_MS, userId, body.lease, now);
      return result.rowsWritten ? rdpJson({ success: true }) : error(404, 'session_ended');
    }
    return error(404, 'not_found');
  }

  private async save(userId: number, existing: Row | null, body: unknown): Promise<Response> {
    const input = parseRdpProfile(body);
    if (!input) return error(400, 'invalid_profile');
    if (existing && (body as { revision?: unknown }).revision !== existing.revision) return error(409, 'profile_changed');
    let access = existing?.route === 'tunnel' && existing.host === input.host && input.route === 'tunnel' ? existing.access : null;
    if (input.accessId !== undefined) {
      access = input.accessId ? await this.encrypt(JSON.stringify([input.accessId, input.accessSecret]), userId) : null;
    }
    return this.transaction(() => {
      const id = existing?.id ?? crypto.randomUUID();
      const revision = (existing?.revision ?? 0) + 1;
      if (existing) {
        const result = this.sql.exec(`UPDATE rdp_profiles SET revision=?, name=?, route=?, host=?, fingerprint=?, access=?
          WHERE user_id=? AND id=? AND revision=?`, revision, input.name, input.route, input.host, input.fingerprint, access, userId, id, existing.revision);
        if (!result.rowsWritten) return error(409, 'profile_changed');
        this.sql.exec('DELETE FROM rdp_tickets WHERE user_id = ? AND profile = ?', userId, id);
        this.sql.exec('DELETE FROM rdp_leases WHERE user_id = ? AND profile = ?', userId, id);
      } else {
        if (this.count('rdp_profiles', userId) >= RDP_MAX_PROFILES) return error(409, 'profile_limit');
        this.sql.exec('INSERT INTO rdp_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, userId, revision, input.name, input.route, input.host, input.fingerprint, access);
      }
      return rdpJson(profile({ ...input, id, revision, access }), existing ? 200 : 201);
    });
  }

  private async issue(userId: number, id: string, binding: string): Promise<Response> {
    const ticket = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const hash = await rdpDigest(ticket);
    return this.transaction(() => {
      const now = Date.now();
      this.clean(now);
      const row = this.row(userId, id);
      if (!row) return error(404, 'not_found');
      if (this.count('rdp_tickets', userId) >= MAX_TICKETS) return error(429, 'ticket_limit');
      this.sql.exec('INSERT INTO rdp_tickets VALUES (?, ?, ?, ?, ?, ?)', hash, userId, id, row.revision, binding, now + TICKET_MS);
      return rdpJson({ ticket, revision: row.revision });
    });
  }

  private async claim(userId: number, ticket: string, binding: string): Promise<Response> {
    const hash = await rdpDigest(ticket);
    const result = this.transaction(() => {
      this.clean(Date.now());
      const token = this.sql.exec('SELECT * FROM rdp_tickets WHERE user_id = ? AND hash = ?', userId, hash).toArray()[0] as unknown as TicketRow | undefined;
      if (!token || token.binding !== binding) return null;
      this.sql.exec('DELETE FROM rdp_tickets WHERE user_id = ? AND hash = ?', userId, hash);
      const row = this.row(userId, token.profile);
      if (!row || row.revision !== token.revision || this.count('rdp_leases', userId) >= MAX_SESSIONS) return null;
      const lease = crypto.randomUUID();
      this.sql.exec('INSERT INTO rdp_leases VALUES (?, ?, ?, ?, ?)', lease, userId, row.id, row.revision, Date.now() + RDP_LEASE_MS);
      return { lease, row };
    });
    if (!result) return error(409, 'ticket_rejected');
    const { lease, row } = result;
    try {
      const access: [string, string] | null = row.access ? JSON.parse(await this.decrypt(row.access, userId)) : null;
      if (this.row(userId, row.id)?.revision !== row.revision) return error(409, 'profile_changed');
      const value: RdpLease = { id: lease, profile: profile(row), accessId: access?.[0], accessSecret: access?.[1] };
      return rdpJson(value);
    } catch {
      this.sql.exec('DELETE FROM rdp_leases WHERE user_id = ? AND id = ?', userId, lease);
      return error(500, 'session_unavailable');
    }
  }
}
