import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { RDP_CLIENT_REVISION, RDP_CONNECTOR_BINDING_FILENAME, rdpConnectorSetupFilename } from '../../src/rdp-schema';
import type { Env } from '../../src/types';
import { inspectRdpConnectorArchive, personalRdpConnectorArchive } from '../../src/worker/rdp-connector-archive';
import { handleRdp, type RdpAssets } from '../../src/worker/rdp-routes';

const exe = 'cloudssh-rdp-connector-windows-amd64.exe';
const approvedNames = [exe, 'LICENSES.txt', 'SHA256SUMS'];
const fixtureData = Buffer.from('MZ-not-a-real-executable-'.repeat(40));

function makeArchive(members = approvedNames, descriptor = false): ArrayBuffer {
  let offset = 0;
  const locals: Buffer[] = [], central: Buffer[] = [];
  for (const name of members) {
    const n = Buffer.from(name), bytes = descriptor ? deflateRawSync(fixtureData) : fixtureData;
    const flags = descriptor ? 8 : 0, method = descriptor ? 8 : 0, crc = crc32(fixtureData);
    const l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(flags, 6); l.writeUInt16LE(method, 8);
    l.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(fixtureData.length, 24);
    const parts = [l, n, bytes];
    if (descriptor) {
      const d = Buffer.alloc(16); d.writeUInt32LE(0x08074b50);
      c.copy(d, 4, 16, 28); parts.push(d);
    } else c.copy(l, 14, 16, 28);
    locals.push(...parts); central.push(c, n);
    offset += parts.reduce((sum, p) => sum + p.length, 0);
  }
  const records = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(records.length, 12); end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, records, end])).buffer;
}

/** Independent ZIP test reader: central offsets, decompression and CRC of the added entry. */
function unpack(data: ArrayBuffer) {
  const b = Buffer.from(data), end = b.length - 22;
  let at = b.readUInt32LE(end + 16);
  const entries: Record<string, Buffer> = {};
  for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
    expect(b.readUInt32LE(at)).toBe(0x02014b50);
    const length = b.readUInt16LE(at + 28), name = b.toString('utf8', at + 46, at + 46 + length);
    const offset = b.readUInt32LE(at + 42), start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
    const bytes = b.subarray(start, start + b.readUInt32LE(at + 20));
    const body = b.readUInt16LE(at + 10) === 8 ? inflateRawSync(bytes) : bytes;
    expect(crc32(body)).toBe(b.readUInt32LE(at + 16));
    entries[name] = body;
    at += 46 + length + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
  }
  expect(at).toBe(end);
  return entries;
}

describe('personal Windows setup archive', () => {
  it.each([false, true])('preserves every source member, including installer bytes (descriptor %s)', async descriptor => {
    const original = makeArchive(approvedNames, descriptor);
    const parsed = inspectRdpConnectorArchive(original)!;
    expect(parsed).not.toBeNull();
    const grant = { version: 3, origin: 'https://desk.example', grant: 'fixture-only' };
    const packed = (await personalRdpConnectorArchive(parsed, grant)!.arrayBuffer());
    const files = unpack(packed);
    for (const name of approvedNames) expect(files[name]).toEqual(fixtureData);
    expect(Object.keys(files)).toHaveLength(4);
    expect(JSON.parse(files[RDP_CONNECTOR_BINDING_FILENAME].toString())).toEqual(grant);
    expect(Buffer.from(packed).subarray(0, parsed.locals.length)).toEqual(Buffer.from(parsed.locals));
  });
  it('rejects unexpected, duplicate, deferred local paths, encrypted entries, symlinks and trailing bytes', () => {
    for (const names of [[exe, 'LICENSES.txt', '../start.exe'], [exe, exe, 'LICENSES.txt'], [...approvedNames, RDP_CONNECTOR_BINDING_FILENAME]])
      expect(inspectRdpConnectorArchive(makeArchive(names))).toBeNull();
    for (const change of [
      (b: Buffer) => { b[30] = '.'.charCodeAt(0); },
      (b: Buffer) => { b.writeUInt16LE(1, b.readUInt32LE(b.length - 6) + 8); },
      (b: Buffer) => { b.writeUInt32LE(0xa0000000, b.readUInt32LE(b.length - 6) + 38); },
      (b: Buffer) => { b.writeUInt16LE(1, b.length - 2); },
    ]) {
      const modified = makeArchive(); change(Buffer.from(modified));
      expect(inspectRdpConnectorArchive(modified)).toBeNull();
    }
  });
  it('fails before issuing a grant for a wrong owner, old revision, existing binding or broken ZIP', async () => {
    const id = '12345678-1234-1234-1234-123456789abc', origin = 'https://desk.example';
    const url = new URL(`/api/rdp/profiles/${id}/connector-setup`, origin);
    const post = (revision: number, auth = true, source = origin) => new Request(url, { method: 'POST',
      headers: { Origin: source, 'X-CloudSSH-RDP-Client': String(RDP_CLIENT_REVISION), ...(auth ? { Cookie: 'session=42:test' } : {}) },
      body: JSON.stringify({ revision }) });
    let card: { hasLogin: boolean; revision: number; connector: { state: string } } | null = null;
    const db = vi.fn(async (req: Request) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === '/internal/session/verify') return Response.json({ id: 5, github_id: 42 });
      if (pathname.endsWith('/connector-setup')) return Response.json({ ok: true });
      return card ? Response.json(card) : new Response(null, { status: 404 });
    });
    const sign = vi.fn(() => Response.json({ signature: 'a'.repeat(64) }));
    const env = { GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture', USER_DB: { idFromName: () => '42', get: () => ({ fetch: db }) },
      RDP_AUTHORITY: { idFromName: () => 'authority', get: () => ({ fetch: sign }) } } as unknown as Env;
    const assets: RdpAssets = { page: '', bootstrap: '', socket: '', peer: '', freerdp: '', wasm: new ArrayBuffer(0), license: '', tags: [], connectorPreview: makeArchive() };
    const handle = (request: Request, local = assets) => handleRdp(request, url, env, local);
    expect((await handle(post(1, false))).status).toBe(401);
    expect((await handle(post(1, true, 'https://other.example'))).status).toBe(403);
    expect((await handle(post(1))).status).toBe(404);
    card = { hasLogin: true, revision: 2, connector: { state: 'online' } };
    expect((await handle(post(2))).status).toBe(409);
    card.connector.state = 'unbound';
    expect((await handle(post(1))).status).toBe(409);
    expect((await handle(post(2), { ...assets, connectorPreview: new ArrayBuffer(1024) })).status).toBe(503);
    expect(sign).not.toHaveBeenCalled();
    expect(db.mock.calls.some(([request]) => request.url.includes('connector-setup'))).toBe(false);
    const response = await handle(post(2));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Content-Disposition')).toContain(rdpConnectorSetupFilename(id));
    expect(response.headers.get('X-CloudSSH-Connector-Build')).toBe('test-unsigned');
    const files = unpack(await response.arrayBuffer());
    const binding = JSON.parse(files[RDP_CONNECTOR_BINDING_FILENAME].toString());
    expect(binding).toEqual({ version: 3, origin, grant: expect.stringMatching(/^e3\./), expires: expect.any(Number) });
    const prepared = await db.mock.calls.at(-1)![0].json<Record<string, unknown>>();
    expect(prepared).toEqual({ revision: 2, proof: expect.stringMatching(/^[a-f0-9]{64}$/), expires: binding.expires });
    expect(prepared.proof).not.toBe(binding.grant.split('.')[5]);
  });
});
