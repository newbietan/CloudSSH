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
  it('needs possession and explicit confirmation, persists binding, rejects replay and isolates account/origin', async () => {
    const db = new DatabaseSync(':memory:');
    const w: Socket[] = [];
    const state = { getWebSockets: () => w, acceptWebSocket: (s: Socket) => w.push(s) } as unknown as DurableObjectState;
    const sqlite = { exec(q: string, ...args: (string | number)[]) { const st = db.prepare(q);
      return q.startsWith('SELECT') ? { toArray: () => st.all(...args) } : { rowsWritten: st.run(...args).changes }; } } as unknown as SqlStorage;
    const native = Response;
    vi.stubGlobal('Response', class extends native { constructor(body?: BodyInit | null, init?: ResponseInit) { super(body, init?.status === 101 ? { status: 200 } : init); } });
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = new Socket(); });
    const tx = <T>(fn: () => T) => fn();
    try {
      db.exec('CREATE TABLE rdp_profiles(user_id INT,id TEXT,revision INT); CREATE TABLE rdp_profile_options(user_id INT,profile TEXT,login TEXT)');
      db.prepare('INSERT INTO rdp_profiles VALUES (1,?,2)').run(id);
      db.prepare('INSERT INTO rdp_profile_options VALUES (1,?,?)').run(id, 'encrypted');
      let store = new RdpDevices(sqlite, tx, state);
      const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
      const pub = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer).toString('base64url');
      const fp = await deviceKeyFingerprint(pub);
      const expires = Date.now() + 60_000;
      expect(store.begin(2, id, origin, 2, proof, expires).ok).toBe(false);
      expect(store.begin(1, id, origin, 1, proof, expires).ok).toBe(false);
      expect(store.begin(1, id, origin, 2, proof, expires).ok).toBe(true);
      expect((await store.register(1, id, 'https://alias.example', proof, pub, 'WINDOWS')).ok).toBe(false);
      const { device } = await (await store.register(1, id, origin, proof, pub, 'WINDOWS')).json<{ device: string }>();
      expect(await (await store.register(1, id, origin, proof, pub, 'WINDOWS')).json()).toMatchObject({ device, fingerprint: fp });
      expect((await store.register(1, id, origin, proof, pub, 'ANOTHER')).ok).toBe(false);
      expect(store.status(1, id, origin)).toMatchObject({ state: 'pending', id: device, fingerprint: fp });
      expect(store.challenge(1, id, device, origin).ok).toBe(false);
      expect(store.confirm(1, id, origin, device, proof).ok).toBe(false);
      expect(store.confirm(1, id, origin, device, fp).ok).toBe(true);
      expect(store.begin(1, id, origin, 2, proof, expires).ok).toBe(false);
      expect(store.status(1, id, origin)).toMatchObject({ state: 'offline' });
      const { challenge } = await store.challenge(1, id, device, origin).json<{ challenge: string }>();
      const token = 'routing-envelope';
      const sig = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(standbyMessage(token, challenge)))).toString('base64url');
      expect((await store.standby(1, id, device, origin, challenge, sig, 'invalid')).ok).toBe(false);
      expect((await store.standby(1, id, device, origin, challenge, sig, token)).ok).toBe(true);
      expect((await store.standby(1, id, device, origin, challenge, sig, token)).ok).toBe(false);
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
