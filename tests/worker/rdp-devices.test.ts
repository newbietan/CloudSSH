import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { deviceKeyFingerprint, standbyMessage } from '../../src/worker/rdp-device-auth';
import { RdpDevices } from '../../src/worker/rdp-devices';

const id = '12345678-1234-1234-1234-123456789abc';
const origin = 'https://desk.example';
const proof = 'a'.repeat(64);
class Socket {
  readyState = 1;
  attachment: unknown;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  serializeAttachment(a: unknown) { this.attachment = a; }
  deserializeAttachment() { return this.attachment; }
}

describe('RDP device enrollment and hibernating presence', () => {
  it('consumes only the current device package, binds at the first signed standby, and isolates account/origin', async () => {
    const db = new DatabaseSync(':memory:');
    const w: Socket[] = [];
    const state = { getWebSockets: () => w, acceptWebSocket: (s: Socket) => w.push(s) } as unknown as DurableObjectState;
    const sqlite = { exec(q: string, ...args: (string | number)[]) { const st = db.prepare(q);
      return /^(SELECT|PRAGMA)/.test(q) ? { toArray: () => st.all(...args) } : { rowsWritten: st.run(...args).changes }; } } as unknown as SqlStorage;
    const native = Response;
    vi.stubGlobal('Response', class extends native { constructor(body?: BodyInit | null, init?: ResponseInit) { super(body, init?.status === 101 ? { status: 200 } : init); } });
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = new Socket(); });
    const tx = <T>(fn: () => T) => fn();
    try {
      db.exec('CREATE TABLE rdp_profiles(user_id INT,id TEXT,revision INT); CREATE TABLE rdp_profile_options(user_id INT,profile TEXT,login TEXT)');
      db.prepare('INSERT INTO rdp_profiles VALUES (1,?,2)').run(id);
      db.prepare('INSERT INTO rdp_profile_options VALUES (1,?,?)').run(id, 'encrypted');
      // Recreate the prior schema and a manually-confirmed-flow enrollment; migration must not approve it.
      db.exec(`CREATE TABLE rdp_device_enrollments(user_id INTEGER NOT NULL, profile TEXT NOT NULL,
        revision INTEGER NOT NULL, origin TEXT NOT NULL, proof TEXT NOT NULL, expires INTEGER NOT NULL,
        device TEXT NOT NULL, key TEXT, label TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id,profile))`);
      db.prepare('INSERT INTO rdp_device_enrollments VALUES (?,?,?,?,?,?,?,?,?,?)').run(1, id, 2, origin, proof, Date.now() + 60_000, id, 'legacy-pub', 'Legacy', proof);
      let store = new RdpDevices(sqlite, tx, state);
      expect(store.status(1, id, origin)).toEqual({ state: 'unbound' });
      expect(store.challenge(1, id, id, origin).status).toBe(410);
      const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
      const pub = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer).toString('base64url');
      const fp = await deviceKeyFingerprint(pub);
      const expires = Date.now() + 60_000;
      expect(store.begin(2, id, origin, 2, proof, expires).ok).toBe(false);
      expect(store.begin(1, id, origin, 1, proof, expires).ok).toBe(false);
      expect(store.begin(1, id, origin, 2, proof, expires).ok).toBe(true);
      expect((await store.register(1, id, 'https://alias.example', proof, pub, 'WINDOWS')).ok).toBe(false);
      const { device: replaced } = await (await store.register(1, id, origin, proof, pub, 'WINDOWS')).json<{ device: string }>();
      const newest = 'b'.repeat(64);
      expect(store.begin(1, id, origin, 2, newest, expires).ok).toBe(true);
      expect((await store.register(1, id, origin, proof, pub, 'WINDOWS')).status).toBe(401);
      expect(store.challenge(1, id, replaced, origin).status).toBe(410);
      const { device } = await (await store.register(1, id, origin, newest, pub, 'WINDOWS')).json<{ device: string }>();
      expect(await (await store.register(1, id, origin, newest, pub, 'WINDOWS')).json()).toMatchObject({ device, fingerprint: fp });
      const otherKey = Buffer.alloc(32, 1).toString('base64url');
      expect((await store.register(1, id, origin, newest, otherKey, 'WINDOWS')).status).toBe(401);
      expect((await store.register(1, id, origin, newest, pub, 'ANOTHER')).status).toBe(401);
      expect(store.status(1, id, origin)).toMatchObject({ state: 'waiting' });
      expect(store.matches(1, id, device, origin)).toBe(false); // Registering alone did not yet bind this host.
      const { challenge } = await store.challenge(1, id, device, origin).json<{ challenge: string }>();
      const token = 'routing-envelope';
      const sig = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(standbyMessage(token, challenge)))).toString('base64url');
      expect((await store.standby(1, id, device, origin, challenge, sig, 'invalid')).ok).toBe(false);
      expect(store.matches(1, id, device, origin)).toBe(false);
      expect((await store.standby(1, id, device, origin, challenge, sig, token)).ok).toBe(true);
      expect((await store.standby(1, id, device, origin, challenge, sig, token)).ok).toBe(false);
      expect(store.begin(1, id, origin, 2, proof, expires).ok).toBe(false);
      expect(await (await store.register(1, id, origin, newest, pub, 'WINDOWS')).json()).toMatchObject({ device, fingerprint: fp });
      expect((await store.register(1, id, origin, newest, otherKey, 'WINDOWS')).status).toBe(401);
      db.prepare('UPDATE rdp_device_enrollments SET expires=? WHERE profile=?').run(Date.now() - 1, id);
      expect((await store.register(1, id, origin, newest, pub, 'WINDOWS')).status).toBe(401);
      store = new RdpDevices(sqlite, tx, state); // Restore only serialized hibernation attachment, not a JS Map.
      expect(store.status(1, id, origin)).toMatchObject({ state: 'online' });
      expect(store.status(1, id, 'https://alias.example')).toEqual({ state: 'other_origin', origin });
      expect(store.available(2, id, origin)).toBeUndefined();
      expect(store.invite(1, id, origin, 'wrong', proof)).toBe(false);
      expect(store.invite(1, id, origin, device, proof)).toBe(true);
      expect(w[0].send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'connect', proof }));
      store.unlink(1, id);
      expect(w[0].close).toHaveBeenCalledWith(1000, 'device_unlinked');
      expect(store.challenge(1, id, device, origin).status).toBe(410);
    } finally { vi.unstubAllGlobals(); db.close(); }
  });
});
