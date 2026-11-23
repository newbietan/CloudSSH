import {
  type RdpCard, type RdpProfile, type RdpRoute, RDP_MAX_PROFILES, isRdpId, isRdpLogin, parseRdpProfile, readRdpJson,
} from '../rdp-schema';

import { parseStoredServerTags } from '../server-tags';

const withOptions = `SELECT p.*, o.tags, o.login, m.username_enc, m.identity_revision,
  m.created_at, m.updated_at, m.last_connected_at FROM rdp_profiles p
  LEFT JOIN rdp_profile_options o ON o.profile=p.id AND o.user_id=p.user_id
  LEFT JOIN rdp_card_metadata m ON m.profile=p.id AND m.user_id=p.user_id`;
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
  tags: string | null;
  login: string | null;
  username_enc: string | null;
  identity_revision: number | null;
  created_at: number | null;
  updated_at: number | null;
  last_connected_at: number | null;
}
interface TicketRow { profile: string; revision: number; binding: string; expires: number }
export interface RdpLease { id: string; profile: RdpProfile; accessId?: string; accessSecret?: string }

export const rdpJson = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});
const error = (status: number, code: string) => rdpJson({ code }, status);
const profile = ({ id, revision, name, route, host, fingerprint, access, tags, login }: Row): RdpProfile => ({
  id, revision, name, route, host, fingerprint: fingerprint || null, hasAccessToken: !!access, hasLogin: !!login, tags: parseStoredServerTags(tags),
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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rdp_profile_options (
      user_id INTEGER NOT NULL, profile TEXT NOT NULL, tags TEXT NOT NULL, login TEXT,
      PRIMARY KEY (user_id, profile)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rdp_card_metadata (
      user_id INTEGER NOT NULL, profile TEXT NOT NULL, username_enc TEXT, identity_revision INTEGER,
      created_at INTEGER, updated_at INTEGER, last_connected_at INTEGER, PRIMARY KEY(user_id,profile)
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
    return this.sql.exec(`${withOptions} WHERE p.user_id = ? AND p.id = ?`, userId, id).toArray()[0] as unknown as Row | undefined;
  }
  private clean(now: number): void {
    this.sql.exec('DELETE FROM rdp_tickets WHERE expires <= ?', now);
    this.sql.exec('DELETE FROM rdp_leases WHERE expires <= ?', now);
  }
  private count(kind: 'rdp_profiles' | 'rdp_tickets' | 'rdp_leases', userId: number): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS count FROM ${kind} WHERE user_id = ?`, userId).one().count);
  }

  private async cards(userId: number): Promise<Response> {
    const rows = () => this.sql.exec(`${withOptions} WHERE p.user_id=? ORDER BY p.name,p.id LIMIT ?`, userId, RDP_MAX_PROFILES).toArray() as unknown as Row[];
    const names = new Map<string, { revision: number; username: string }>();
    // Bounded and sequential: avoid repeated concurrent KDF work on a cold account.
    for (const row of rows()) {
      if (!row.login) continue;
      try {
        let username: string;
        if (row.username_enc && row.identity_revision === row.revision) {
          username = await this.decrypt(row.username_enc, userId);
        } else {
          // Old profiles have no separate encrypted display name. Backfill only the same revision.
          const login: unknown = JSON.parse(await this.decrypt(row.login, userId));
          if (!isRdpLogin(login)) continue;
          username = login.username;
          const encrypted = await this.encrypt(username, userId);
          this.sql.exec(`INSERT INTO rdp_card_metadata(user_id,profile,username_enc,identity_revision)
            SELECT user_id,id,?,revision FROM rdp_profiles WHERE user_id=? AND id=? AND revision=?
            ON CONFLICT(user_id,profile) DO UPDATE SET username_enc=excluded.username_enc, identity_revision=excluded.identity_revision`,
          encrypted, userId, row.id, row.revision);
        }
        names.set(row.id, { revision: row.revision, username });
      } catch { /* Unreadable identity is unknown, not Administrator. Never log credential data. */ }
    }
    // An edit or deletion during decryption must not publish an old identity.
    const profiles: RdpCard[] = rows().map(row => {
      const name = names.get(row.id);
      return { ...profile(row), username: name?.revision === row.revision ? name.username : null,
        last_connected_at: row.last_connected_at, created_at: row.created_at, updated_at: row.updated_at };
    });
    return rdpJson({ profiles });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = Number(url.searchParams.get('user_id'));
    if (!Number.isSafeInteger(userId) || userId < 1) return error(400, 'invalid_request');
    const route = url.pathname.slice('/internal/rdp/'.length);
    if (route === 'profiles') {
      if (request.method === 'GET') return this.cards(userId);
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
          this.sql.exec('DELETE FROM rdp_card_metadata WHERE user_id=? AND profile=?', userId, id);
          this.sql.exec('DELETE FROM rdp_profile_options WHERE user_id=? AND profile=?', userId, id);
          this.sql.exec('DELETE FROM rdp_profiles WHERE user_id = ? AND id = ?', userId, id);
          this.sql.exec('DELETE FROM rdp_tickets WHERE user_id = ? AND profile = ?', userId, id);
          this.sql.exec('DELETE FROM rdp_leases WHERE user_id = ? AND profile = ?', userId, id);
        });
        return rdpJson({ success: true });
      }
    }
    if (kind === 'profiles' && isRdpId(id) && route === `profiles/${id}/trust` && request.method === 'PUT') {
      const payload = await readRdpJson(request) as Record<string, unknown> | null;
      if (!payload || !digestPattern(payload.fingerprint) || !isRdpId(payload.lease) ||
          typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision)) {
        return error(400, 'invalid_request');
      }
      return this.trust(userId, id, payload.revision, payload.lease, payload.fingerprint);
    }
    if (kind === 'profiles' && isRdpId(id) && route === `profiles/${id}/login-identity` && request.method === 'POST') {
      const body = await readRdpJson(request) as { revision?: number } | null;
      const revision = body?.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return error(400, 'invalid_request');
      const login = await this.readLogin(userId, id, revision);
      if (login instanceof Response) return login;
      return rdpJson({ username: login.username, domain: login.domain, revision });
    }
    if (request.method !== 'POST') return error(405, 'method_not_allowed');
    const body = await readRdpJson(request) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return error(400, 'invalid_request');
    if (route === 'ticket' && isRdpId(body.profile) && digestPattern(body.binding)) {
      if (typeof body.savedRevision !== 'number' || !Number.isSafeInteger(body.savedRevision) || body.savedRevision < 1) return error(400, 'invalid_request');
      return this.issue(userId, body.profile, body.binding, body.savedRevision);
    }
    if (route === 'claim' && digestPattern(body.ticket) && digestPattern(body.binding)) {
      return this.claim(userId, body.ticket, body.binding);
    }
    if (route === 'desktop-ready' && isRdpId(body.lease)) {
      const now = Date.now();
      const result = this.sql.exec(`INSERT INTO rdp_card_metadata(user_id,profile,last_connected_at)
        SELECT p.user_id,p.id,? FROM rdp_leases l JOIN rdp_profiles p ON p.id=l.profile AND p.user_id=l.user_id AND p.revision=l.revision
        WHERE l.id=? AND l.user_id=? AND l.expires>?
        ON CONFLICT(user_id,profile) DO UPDATE SET last_connected_at=MAX(COALESCE(last_connected_at,0),excluded.last_connected_at)`, now, body.lease, userId, now);
      return result.rowsWritten ? rdpJson({ success: true }) : error(409, 'session_ended');
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

  private trust(userId: number, id: string, revision: number, lease: string, fingerprint: string): Response {
    return this.transaction(() => {
      const row = this.row(userId, id);
      if (!row) return error(404, 'not_found');
      if (row.revision !== revision || (row.fingerprint && row.fingerprint !== fingerprint)) return error(409, 'trust_changed');
      const active = this.sql.exec(`SELECT id FROM rdp_leases
        WHERE user_id=? AND profile=? AND revision=? AND id=? AND expires>?`, userId, id, revision, lease, Date.now()).toArray();
      if (!active.length) return error(409, 'session_ended');
      if (!row.fingerprint) {
        this.sql.exec('UPDATE rdp_profiles SET fingerprint=? WHERE user_id=? AND id=? AND revision=? AND fingerprint=?', fingerprint, userId, id, revision, '');
      }
      // First acceptance does not change the destination revision during a live TLS handshake.
      return rdpJson({ fingerprint });
    });
  }

  private async save(userId: number, existing: Row | null, body: unknown): Promise<Response> {
    const input = parseRdpProfile(body);
    if (!input) return error(400, 'invalid_profile');
    if (existing && (body as { revision?: unknown }).revision !== existing.revision) return error(409, 'profile_changed');
    const sameTarget = existing?.route === input.route && existing.host === input.host;
    if (!input.login && !(sameTarget && existing.login && input.login === undefined)) return error(400, 'login_required');
    let access = sameTarget && input.route === 'tunnel' ? existing.access : null;
    if (input.accessId !== undefined) {
      access = input.accessId ? await this.encrypt(JSON.stringify([input.accessId, input.accessSecret]), userId) : null;
    }
    const login = input.login ? await this.encrypt(JSON.stringify(input.login), userId) : existing!.login;
    const usernameEnc = input.login ? await this.encrypt(input.login.username, userId)
      : existing && existing.identity_revision === existing.revision ? existing.username_enc : null;
    return this.transaction(() => {
      const id = existing?.id ?? crypto.randomUUID();
      const revision = (existing?.revision ?? 0) + 1;
      // Preserve newer first-use acceptance made while encryption or body parsing awaited.
      const fingerprint = sameTarget && existing ? this.row(userId, id)?.fingerprint ?? '' : '';
      if (existing) {
        const result = this.sql.exec(`UPDATE rdp_profiles SET revision=?, name=?, route=?, host=?, fingerprint=?, access=?
          WHERE user_id=? AND id=? AND revision=?`, revision, input.name, input.route, input.host, fingerprint, access, userId, id, existing.revision);
        if (!result.rowsWritten) return error(409, 'profile_changed');
        this.sql.exec('DELETE FROM rdp_tickets WHERE user_id = ? AND profile = ?', userId, id);
        this.sql.exec('DELETE FROM rdp_leases WHERE user_id = ? AND profile = ?', userId, id);
      } else {
        if (this.count('rdp_profiles', userId) >= RDP_MAX_PROFILES) return error(409, 'profile_limit');
        this.sql.exec('INSERT INTO rdp_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, userId, revision, input.name, input.route, input.host, fingerprint, access);
      }
      const tags = JSON.stringify(input.tags ?? parseStoredServerTags(existing?.tags));
      this.sql.exec(`INSERT INTO rdp_profile_options(user_id,profile,tags,login) VALUES (?,?,?,?)
        ON CONFLICT(user_id,profile) DO UPDATE SET tags=excluded.tags,login=excluded.login`, userId, id, tags, login);
      const now = Date.now();
      this.sql.exec(`INSERT INTO rdp_card_metadata(user_id,profile,username_enc,identity_revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,profile) DO UPDATE SET username_enc=excluded.username_enc,
        identity_revision=excluded.identity_revision, updated_at=excluded.updated_at,
        last_connected_at=CASE WHEN ? THEN last_connected_at ELSE NULL END`,
      userId, id, usernameEnc, revision, existing ? null : now, now, sameTarget ? 1 : 0);
      return rdpJson(profile(this.row(userId, id)!), existing ? 200 : 201);
    });
  }

  private async readLogin(userId: number, id: string, revision: number) {
    const row = this.row(userId, id);
    if (!row) return error(404, 'not_found');
    if (!row.login || row.revision !== revision) return error(409, 'profile_changed');
    try {
      const login: unknown = JSON.parse(await this.decrypt(row.login, userId));
      if (this.row(userId, id)?.revision !== revision) return error(409, 'profile_changed');
      return isRdpLogin(login) ? login : error(500, 'login_unavailable');
    } catch { return error(500, 'login_unavailable'); }
  }

  private async issue(userId: number, id: string, binding: string, savedRevision: number): Promise<Response> {
    const ticket = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const hash = await rdpDigest(ticket);
    const login = await this.readLogin(userId, id, savedRevision);
    if (login instanceof Response) return login;
    return this.transaction(() => {
      const now = Date.now();
      this.clean(now);
      const row = this.row(userId, id);
      if (!row) return error(404, 'not_found');
      if (row.revision !== savedRevision) return error(409, 'profile_changed');
      if (this.count('rdp_tickets', userId) >= MAX_TICKETS) return error(429, 'ticket_limit');
      this.sql.exec('INSERT INTO rdp_tickets VALUES (?, ?, ?, ?, ?, ?)', hash, userId, id, row.revision, binding, now + TICKET_MS);
      return rdpJson({ ticket, revision: row.revision, login });
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
      if (!row?.login || row.revision !== token.revision || this.count('rdp_leases', userId) >= MAX_SESSIONS) return null;
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
