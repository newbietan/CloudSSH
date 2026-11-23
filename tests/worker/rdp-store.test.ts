import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { parseRdpProfile } from '../../src/rdp-schema';
import { RdpStore } from '../../src/worker/rdp-store';

const certificate = '1'.repeat(64);
const endpoint = { name: 'Workstation', route: 'direct', host: '93.184.215.14' };
const target = { ...endpoint, login: { username: 'Administrator', domain: '', password: 'test only' } };
const bind = '2'.repeat(64);

function fixture() {
  const database = new DatabaseSync(':memory:');
  const db = { exec(query: string, ...params: (string | number | null)[]) {
    const stmt = database.prepare(query);
    if (/^SELECT/i.test(query)) {
      const rows = stmt.all(...params);
      return { toArray: () => rows, one: () => rows[0] };
    }
    return { rowsWritten: Number(stmt.run(...params).changes) };
  } } as unknown as SqlStorage;
  const store = new RdpStore(db, (callback) => {
    database.exec('BEGIN');
    try { const value = callback(); database.exec('COMMIT'); return value; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }, async value => Buffer.from(value).toString('base64'), async value => Buffer.from(value, 'base64').toString());
  const request = (path: string, method: string, body?: unknown, user = 1) => store.handle(new Request(`https://internal/internal/rdp/${path}?user_id=${user}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { request, database };
}

describe('RDP profiles and connection leases', () => {
  it('rejects private/literal quirks and non-RDP target or secret fields', () => {
    for (const host of ['127.0.0.1', '0.0.0.0', 'fd00::1', '192.168.1.1', '198.51.100.3', '10.0.0.8', '93.018.215.14', 'www.example.com']) {
      expect(parseRdpProfile({ ...target, host })).toBeNull();
    }
    expect(parseRdpProfile(target)).toEqual(target);
    expect(parseRdpProfile({ ...target, fingerprint: certificate })).toBeNull();
    expect(parseRdpProfile({ ...target, password: 'not allowed' })).toBeNull();
    expect(parseRdpProfile({ ...target, route: 'tunnel', host: 'a.test/foo' })).toBeNull();
  });

  it('isolates profiles, issues a one-use browser-bound ticket, and revokes leases on edit', async () => {
    const { request, database } = fixture();
    try {
      const saved = await request('profiles', 'POST', target);
      expect(saved.status).toBe(201);
      const { id, revision } = await saved.json() as { id: string; revision: number };
      expect((await request(`profiles/${id}`, 'GET', undefined, 2)).status).toBe(404);
      expect((await request('ticket', 'POST', { profile: id, binding: bind, savedRevision: revision }, 2)).status).toBe(404);
      const { ticket } = await (await request('ticket', 'POST', { profile: id, binding: bind, savedRevision: revision })).json() as { ticket: string };
      expect(database.prepare('SELECT hash FROM rdp_tickets').get()?.hash).not.toBe(ticket);
      expect((await request('claim', 'POST', { ticket, binding: '3'.repeat(64) })).status).toBe(409);
      const claimed = await request('claim', 'POST', { ticket, binding: bind });
      expect(claimed.status).toBe(200);
      const { id: lease } = await claimed.json() as { id: string };
      expect((await request('claim', 'POST', { ticket, binding: bind })).status).toBe(409);
      expect((await request('renew', 'POST', { lease })).status).toBe(200);
      expect((await request(`profiles/${id}`, 'PUT', { ...target, revision, name: 'Renamed' })).status).toBe(200);
      expect((await request('renew', 'POST', { lease })).status).toBe(404);
    } finally { database.close(); }
  });

  it('binds first-use trust to the owner, active lease and destination revision and never overwrites a pin', async () => {
    const { request, database } = fixture();
    try {
      const { id, revision, fingerprint } = await (await request('profiles', 'POST', target)).json() as {
        id: string; revision: number; fingerprint: string | null;
      };
      expect(fingerprint).toBeNull();
      const profile = `profiles/${id}`;
      const { ticket } = await (await request('ticket', 'POST', { profile: id, binding: bind, savedRevision: revision })).json() as { ticket: string };
      const { id: lease } = await (await request('claim', 'POST', { ticket, binding: bind })).json() as { id: string };
      const payload = { revision, lease, fingerprint: certificate };
      expect((await request(`${profile}/trust`, 'PUT', payload, 2)).status).toBe(404);
      expect((await request(`${profile}/trust`, 'PUT', { ...payload, lease: id })).status).toBe(409);
      expect((await request(`${profile}/trust`, 'PUT', { ...payload, revision: revision + 1 })).status).toBe(409);
      expect((await request(`${profile}/trust`, 'PUT', payload)).status).toBe(200);
      expect((await request(`${profile}/trust`, 'PUT', { ...payload, fingerprint: bind })).status).toBe(409);
      const nameEdit = await request(profile, 'PUT', { ...target, name: 'Renamed', revision });
      expect(await nameEdit.json()).toMatchObject({ fingerprint: certificate, revision: revision + 1 });
      expect((await request(`${profile}/trust`, 'PUT', payload)).status).toBe(409);
      const hostEdit = await request(profile, 'PUT', { ...target, host: '8.8.8.8', revision: revision + 1 });
      expect(await hostEdit.json()).toMatchObject({ fingerprint: null });
    } finally { database.close(); }
  });

  it('requires complete login and only returns the password to a matching owner/revision ticket', async () => {
    const { request, database } = fixture();
    try {
      const login = { username: 'saved-user', domain: 'domain', password: ' secret ' };
      const get = async (route: string, method: string, body?: unknown, user = 1) => (await request(route, method, body, user)).json() as Promise<Record<string, unknown>>;
      for (const input of [endpoint, { ...endpoint, login: null }, { ...endpoint, login: { ...login, password: '' } }]) {
        expect((await request('profiles', 'POST', input)).status).toBe(400);
      }
      const saved = await get('profiles', 'POST', { ...target, login, tags: ['Work'] });
      const path = `profiles/${saved.id}`;
      const issue = { profile: saved.id, binding: bind };
      expect(saved).toMatchObject({ hasLogin: true, tags: ['Work'] });
      const cards = await get('profiles', 'GET');
      expect(cards.profiles).toMatchObject([{ username: login.username, last_connected_at: null }]);
      expect(JSON.stringify(cards)).not.toContain(login.password);
      expect(JSON.stringify(cards)).not.toContain(login.domain);
      for (const info of [saved, await get(path, 'GET'), await get('ticket', 'POST', issue)]) expect(JSON.stringify(info)).not.toContain(login.username);
      expect(database.prepare('SELECT login FROM rdp_profile_options').get()?.login).not.toContain(login.password);
      expect((await request('ticket', 'POST', { ...issue, savedRevision: 1 }, 2)).ok).toBe(false);
      expect((await request('ticket', 'POST', { ...issue, savedRevision: 2 })).ok).toBe(false);
      const ticket = await get('ticket', 'POST', { ...issue, savedRevision: 1 });
      expect(ticket.login).toEqual(login);
      expect(JSON.stringify(await get('claim', 'POST', { ticket: ticket.ticket, binding: bind }))).not.toContain(login.username);
      expect(await get(path + '/login-identity', 'POST', { revision: 1 })).toEqual({ username: login.username, domain: login.domain, revision: 1 });
      expect((await request(path + '/login-identity', 'POST', { revision: 1 }, 2)).status).toBe(404);
      expect(await get(path, 'PUT', { ...endpoint, name: 'Renamed', revision: 1 })).toMatchObject({ hasLogin: true });
      expect((await request(path + '/login-identity', 'POST', { revision: 1 })).status).toBe(409);
      expect((await request(path, 'PUT', { ...endpoint, host: '8.8.8.8', revision: 2 })).status).toBe(400);
      expect((await request('ticket', 'POST', { ...issue, savedRevision: 3 })).ok).toBe(false);
      await request(path, 'DELETE');
      expect(database.prepare('SELECT * FROM rdp_profile_options').all()).toHaveLength(0);
      expect(database.prepare('SELECT * FROM rdp_card_metadata').all()).toHaveLength(0);
    } finally { database.close(); }
  });

  it('records first-frame time only for the live owned lease, independently of edit times', async () => {
    const { request, database } = fixture();
    try {
      const { id } = await (await request('profiles', 'POST', target)).json() as { id: string };
      const path = `profiles/${id}`;
      const card = async () => (await (await request('profiles', 'GET')).json() as { profiles: { revision: number; username: string; created_at: number; updated_at: number; last_connected_at: number | null }[] }).profiles[0];
      const initial = await card();
      expect(initial).toMatchObject({ username: target.login.username, revision: 1, created_at: expect.any(Number), last_connected_at: null });
      const { ticket } = await (await request('ticket', 'POST', { profile: id, binding: bind, savedRevision: 1 })).json() as { ticket: string };
      const { id: lease } = await (await request('claim', 'POST', { ticket, binding: bind })).json() as { id: string };
      expect((await request('desktop-ready', 'POST', { lease }, 2)).ok).toBe(false);
      expect(await card()).toEqual(initial);
      expect((await request('desktop-ready', 'POST', { lease })).ok).toBe(true);
      const connected = await card();
      expect(connected).toEqual({ ...initial, last_connected_at: expect.any(Number) });
      await request(path, 'PUT', { ...endpoint, name: 'Renamed', revision: 1 });
      expect((await card()).last_connected_at).toBe(connected.last_connected_at);
      expect((await request('desktop-ready', 'POST', { lease })).ok).toBe(false);
      await request(path, 'PUT', { ...target, host: '8.8.8.8', revision: 2 });
      expect((await card()).last_connected_at).toBeNull();
    } finally { database.close(); }
  });

  it('backfills only an encrypted display username for an older device and does not invent dates', async () => {
    const { request, database } = fixture();
    try {
      await request('profiles', 'POST', target);
      database.exec('DELETE FROM rdp_card_metadata');
      const list = () => request('profiles', 'GET').then(r => r.json());
      expect(await list()).toMatchObject({ profiles: [{ username: target.login.username, created_at: null, updated_at: null, last_connected_at: null }] });
      const field = database.prepare('SELECT username_enc FROM rdp_card_metadata').get()?.username_enc;
      expect(field).toBeTruthy();
      expect(field).not.toBe(target.login.username);
      database.exec("UPDATE rdp_profile_options SET login='not readable'"); // A normal card read no longer decrypts the password blob.
      expect(await list()).toMatchObject({ profiles: [{ username: target.login.username }] });
      expect(await (await request('profiles', 'GET', undefined, 2)).json()).toEqual({ profiles: [] });
    } finally { database.close(); }
  });

  it('never returns the Access credentials in list responses and clears old-host credentials', async () => {
    const { request, database } = fixture();
    try {
      const input = { ...target, route: 'tunnel', host: 'rdp.example.com', accessId: 'mock-id', accessSecret: 'mock-secret' };
      const saved = await (await request('profiles', 'POST', input)).json() as { id: string; revision: number; hasAccessToken: boolean };
      expect(saved.hasAccessToken).toBe(true);
      expect(JSON.stringify(saved)).not.toContain(input.accessSecret);
      const edited = await (await request(`profiles/${saved.id}`, 'PUT', {
        ...target, route: 'tunnel', host: 'replacement.example.com', revision: saved.revision,
      })).json() as { hasAccessToken: boolean };
      expect(edited.hasAccessToken).toBe(false);
    } finally { database.close(); }
  });
});
