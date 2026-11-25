import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { parseRdpProfile } from '../../src/rdp-schema';
import { RdpStore } from '../../src/worker/rdp-store';

const certificate = '1'.repeat(64);
const endpoint = { name: 'Workstation', route: 'direct', host: '93.184.215.14' };
const target = { ...endpoint, login: { username: 'Administrator', domain: '', password: 'test only' } };
const bind = '2'.repeat(64);

function fixture(database = new DatabaseSync(':memory:')) {
  const db = { exec(query: string, ...params: (string | number | null)[]) {
    const stmt = database.prepare(query);
    if (/^(SELECT|PRAGMA)/i.test(query)) {
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
    for (const host of ['127.0.0.1', '0.0.0.0', 'fd00::1', '192.168.1.1', '198.51.100.3', '10.0.0.8', '93.018.215.14', 'www.example.invalid']) {
      expect(parseRdpProfile({ ...target, host })).toBeNull();
    }
    expect(parseRdpProfile(target)).toEqual(target);
    expect(parseRdpProfile({ ...target, fingerprint: certificate })).toBeNull();
    expect(parseRdpProfile({ ...target, password: 'not allowed' })).toBeNull();
    expect(parseRdpProfile({ ...target, route: 'tunnel', host: 'a.test/foo' })).toBeNull();
  });

  it('normalizes public dual-stack endpoints but rejects ambiguous addresses and URLs', () => {
    for (const [host, canonical] of [
      [' RDP.Example.COM. ', 'rdp.example.com'], ['Bücher.Example.COM', 'xn--bcher-kva.example.com'],
      ['[2600:0001:ABCD:0000:0000:0000:0000:0001]', '2600:1:abcd::1'], ['2600:1:abcd::1', '2600:1:abcd::1'],
    ]) expect(parseRdpProfile({ ...target, host, port: 53389 })).toMatchObject({ host: canonical, port: 53389 });
    for (const host of ['https://rdp.example.com', 'rdp.example.com:3389', 'u@rdp.example.com', 'rdp.example.com/a',
      'rdp%2eexample.com', 'rdp..example.com', 'rdp.example.com..', 'rdp.example.com\\foo', 'rdp.local', 'win.home.arpa',
      '127.1', '2130706433', '0x7f.0x0.0x0.0x1', '8.8.8.8.', '[2600:1::1]:3389', '2600:1::1%eth0',
      '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', 'fec0::1', 'ff02::1', '2001:1ff::1', '2001:db8::1', '3fff:fff::1']) {
      expect(parseRdpProfile({ ...target, host })).toBeNull();
    }
    expect(parseRdpProfile({ ...target, route: 'tunnel', host: '2600:1::1' })).toBeNull();
    expect(parseRdpProfile({ ...target, host: 'rdp.example.com', accessId: 'id', accessSecret: 'secret' })).toBeNull();
  });

  it('only accepts numeric, permitted TCP ports on public direct endpoints', () => {
    for (const port of [1, 3389, 3390, 65535]) expect(parseRdpProfile({ ...target, port })).toEqual({ ...target, port });
    for (const port of [0, -1, 65536, 3389.5, NaN, Infinity, null, '', '3390', true, 25, 443, 6379]) {
      expect(parseRdpProfile({ ...target, port })).toBeNull();
    }
    for (const port of [3389, 3390, null]) {
      expect(parseRdpProfile({ ...target, route: 'tunnel', host: 'rdp.example.com', port })).toBeNull();
    }
    expect(parseRdpProfile({ ...target, host: `${target.host}:3390` })).toBeNull();
  });

  it('upgrades existing SQLite rows to 3389 without changing trust, login or revision', async () => {
    const database = new DatabaseSync(':memory:');
    const id = '12345678-1234-1234-1234-123456789abc';
    try {
      database.exec(`CREATE TABLE rdp_profiles (id TEXT PRIMARY KEY,user_id INTEGER,revision INTEGER,name TEXT,route TEXT,host TEXT,fingerprint TEXT,access TEXT);
        CREATE TABLE rdp_profile_options(user_id INTEGER,profile TEXT,tags TEXT,login TEXT,PRIMARY KEY (user_id,profile));`);
      database.prepare('INSERT INTO rdp_profiles VALUES (?,1,7,?,?,?,?,NULL)').run(id, target.name, target.route, target.host, certificate);
      database.prepare('INSERT INTO rdp_profile_options VALUES (1,?,?,?)').run(id, '["old"]', Buffer.from(JSON.stringify(target.login)).toString('base64'));
      for (let coldStart = 0; coldStart < 2; coldStart++) {
        const { request } = fixture(database);
        expect(await (await request(`profiles/${id}`, 'GET')).json()).toMatchObject({ port: 3389, revision: 7, fingerprint: certificate, hasLogin: true, tags: ['old'] });
        expect(await (await request('profiles', 'GET')).json()).toMatchObject({ profiles: [{ port: 3389, username: target.login.username }] });
      }
      database.exec('DELETE FROM rdp_profile_options'); // Pre-login legacy profiles have no options row.
      expect(await (await fixture(database).request(`profiles/${id}`, 'GET')).json()).toMatchObject({ port: 3389, hasLogin: false });
    } finally { database.close(); }
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

  it('binds credentials and trust to the canonical domain, not an address selected by the relay', async () => {
    const { request, database } = fixture();
    try {
      const host = 'rdp.example.com';
      const saved = await request('profiles', 'POST', { ...target, host: 'RDP.Example.COM.' });
      expect(saved.status).toBe(201);
      const { id, revision } = await saved.json() as { id: string; revision: number };
      const path = `profiles/${id}`;
      const issue = async (savedRevision: number) => (await (await request('ticket', 'POST', { profile: id, binding: bind, savedRevision })).json()) as { ticket: string };
      const claim = async (ticket: string) => (await (await request('claim', 'POST', { ticket, binding: bind })).json()) as { id: string; profile: Record<string, unknown> };
      const opened = await claim((await issue(revision)).ticket);
      expect(opened.profile).toMatchObject({ host, port: 3389, fingerprint: null });
      expect((await request(`${path}/trust`, 'PUT', { revision, lease: opened.id, fingerprint: certificate })).status).toBe(200);
      expect((await request('desktop-ready', 'POST', { lease: opened.id })).status).toBe(200);
      const relabel = await request(path, 'PUT', { ...endpoint, revision, host: ' RDP.Example.COM. ', name: 'Renamed' });
      expect(await relabel.json()).toMatchObject({ host, fingerprint: certificate, hasLogin: true });
      const reopened = await claim((await issue(revision + 1)).ticket);
      expect(reopened.profile).toMatchObject({ host, port: 3389, fingerprint: certificate });
      expect(await (await request('profiles', 'GET')).json()).toMatchObject({ profiles: [{ last_connected_at: expect.any(Number) }] });
      const newHost = '2600:1:abcd::1';
      const replacement = { ...endpoint, revision: revision + 1, host: `[${newHost}]` };
      expect((await request(path, 'PUT', replacement)).status).toBe(400);
      const switched = await request(path, 'PUT', { ...replacement, login: target.login });
      expect(await switched.json()).toMatchObject({ host: newHost, fingerprint: null });
      expect(await (await request('profiles', 'GET')).json()).toMatchObject({ profiles: [{ last_connected_at: null }] });
      expect((await request('renew', 'POST', { lease: reopened.id })).status).toBe(404);
    } finally { database.close(); }
  });

  it('binds credentials, certificate, history and the authoritative relay destination to the direct port', async () => {
    const { request, database } = fixture();
    try {
      const json = async (route: string, method: string, body?: unknown) => {
        const response = await request(route, method, body);
        expect(response.ok).toBe(true);
        return await response.json() as Record<string, unknown>;
      };
      const { id } = await json('profiles', 'POST', { ...target, port: 53389 });
      const path = `profiles/${id}`;
      const ticket = async (revision: number) => (await json('ticket', 'POST', { profile: id, binding: bind, savedRevision: revision })).ticket;
      // Old relays hard-code 3389. They must never receive a lease for a custom destination.
      expect((await request('claim', 'POST', { ticket: await ticket(1), binding: bind })).status).toBe(409);
      const claim = await json('claim', 'POST', { ticket: await ticket(1), binding: bind, supportsDirectPort: true });
      expect(claim.profile).toMatchObject({ host: target.host, port: 53389 });
      await json(`${path}/trust`, 'PUT', { revision: 1, lease: claim.id, fingerprint: certificate });
      await json('desktop-ready', 'POST', { lease: claim.id });
      expect(await json(path, 'PUT', { ...endpoint, revision: 1, name: 'Renamed' })).toMatchObject({ port: 53389, fingerprint: certificate });
      expect(await json('profiles', 'GET')).toMatchObject({ profiles: [{ port: 53389, last_connected_at: expect.any(Number) }] });
      const staleTicket = await ticket(2);
      const oldLease = await json('claim', 'POST', { ticket: await ticket(2), binding: bind, supportsDirectPort: true });
      expect((await request(path, 'PUT', { ...endpoint, revision: 2, port: 3389 })).status).toBe(400);
      expect(await json(path, 'GET')).toMatchObject({ port: 53389, revision: 2, fingerprint: certificate });
      const login = { ...target.login, password: 'replacement' };
      expect(await json(path, 'PUT', { ...endpoint, revision: 2, port: 3389, login })).toMatchObject({ port: 3389, fingerprint: null });
      expect(await json('profiles', 'GET')).toMatchObject({ profiles: [{ port: 3389, last_connected_at: null }] });
      expect((await request('renew', 'POST', { lease: oldLease.id })).status).toBe(404);
      expect((await request('claim', 'POST', { ticket: staleTicket, binding: bind, supportsDirectPort: true })).status).toBe(409);
      expect(await json('ticket', 'POST', { profile: id, binding: bind, savedRevision: 3 })).toMatchObject({ login });
      const tunnel = await json(path, 'PUT', { ...target, route: 'tunnel', host: 'rdp.example.com', revision: 3 });
      expect(tunnel).not.toHaveProperty('port');
      expect(await json(path, 'PUT', { ...target, revision: 4 })).toMatchObject({ port: 3389 });
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
