import { afterEach, describe, expect, it, vi } from 'vitest';
import { peerSdp, RdpPeerRooms } from '../../src/worker/rdp-peer-rooms';

const id = '00000001-0000-0000-0000-000000000000', lease = '00000002-0000-0000-0000-000000000000', device = '00000003-0000-0000-0000-000000000000';
const binding = 'a'.repeat(64), ticket = 'c'.repeat(64), origin = 'https://desk.example';
const sdp = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 00:00\r\n';
class Socket extends EventTarget {
  accept() {} send = vi.fn(); close = vi.fn();
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: data instanceof ArrayBuffer || typeof data === 'string' ? data : JSON.stringify(data) })); }
}
function fixture() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = new Socket(); constructor() { sockets.push(this[1]); } });
  const NativeResponse = Response;
  vi.stubGlobal('Response', class extends NativeResponse { constructor(body?: BodyInit | null, init?: ResponseInit) { super(body, init?.status === 101 ? { status: 200 } : init); } });
  const hooks = { claim: vi.fn(async (u, t, b, o) => u === 1 && t === ticket && b === binding && o === origin ? { lease, profile: id, revision: 2, device } : null),
    invite: vi.fn(() => true), record: vi.fn(() => true), release: vi.fn(), renew: vi.fn(() => true) };
  const rooms = new RdpPeerRooms(hooks);
  const request = async (idle = 0) => {
    rooms.browser(1, binding, idle, origin); const browser = sockets.at(-1)!;
    browser.receive({ type: 'ticket', ticket }); await vi.advanceTimersByTimeAsync(0);
    const proof = (hooks.invite.mock.calls[0] as string[])[5];
    return { browser, proof };
  };
  const connect = async (idle = 0) => {
    const { browser, proof } = await request(idle);
    expect(rooms.agent(1, id, device, origin, proof).ok).toBe(true);
    const agent = sockets.at(-1)!;
    expect(browser.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'paired', lease }));
    browser.receive({ type: 'offer', sdp }); agent.receive({ type: 'answer', sdp }); agent.receive({ type: 'connected' });
    return { browser, agent, proof };
  };
  return { rooms, hooks, request, connect, sockets };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('installed-device direct signaling', () => {
  it('wakes only from a browser-bound fresh ticket, then accepts one attach with the intended device, origin and proof', async () => {
    const { rooms, request, hooks, sockets } = fixture();
    rooms.browser(1, 'b'.repeat(64), 0, origin);
    sockets[0].receive({ type: 'ticket', ticket }); await vi.advanceTimersByTimeAsync(0);
    expect(hooks.invite).not.toHaveBeenCalled();
    const { proof } = await request();
    expect(hooks.invite).toHaveBeenCalledWith(1, id, 2, origin, device, proof);
    expect(rooms.agent(2, id, device, origin, proof).ok).toBe(false);
    expect(rooms.agent(1, id, lease, origin, proof).ok).toBe(false);
    expect(rooms.agent(1, id, device, 'https://other.example', proof).ok).toBe(false);
    expect(rooms.agent(1, id, device, origin, binding).ok).toBe(false);
    expect(rooms.agent(1, id, device, origin, proof).ok).toBe(true);
    expect(rooms.agent(1, id, device, origin, proof).ok).toBe(false);
  });
  it('closes an invite on negotiation timeout, and never evicts a prior session for a second attempt', async () => {
    const { rooms, request, hooks, sockets } = fixture();
    const { browser, proof } = await request();
    rooms.browser(1, binding, 0, origin); sockets.at(-1)!.receive({ type: 'ticket', ticket }); await vi.advanceTimersByTimeAsync(0);
    expect(sockets.at(-1)!.close).toHaveBeenCalledWith(1000, 'peer_busy');
    expect(hooks.invite).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(browser.close).toHaveBeenCalledWith(1000, 'peer_timeout');
    expect(rooms.agent(1, id, device, origin, proof).ok).toBe(false);
  });
  it.each(['agent', 'browser'] as const)('never forwards binary on the %s signaling socket', async side => {
    const { connect, hooks } = fixture(); const ends = await connect();
    ends[side].receive(new ArrayBuffer(16)); await vi.advanceTimersByTimeAsync(0);
    expect(ends.agent.close).toHaveBeenCalledWith(1000, 'peer_failed');
    expect(hooks.release).toHaveBeenCalledOnce();
  });
  it('requires a certificate decision before first desktop record and rejects repeated wait', async () => {
    const { connect, hooks } = fixture(); const { browser, agent } = await connect();
    browser.receive({ type: 'cert_wait' }); browser.receive({ type: 'cert_done' }); browser.receive({ type: 'desktop_ready' });
    expect(hooks.record).toHaveBeenCalledOnce();
    browser.receive({ type: 'cert_wait' });
    expect(agent.close).toHaveBeenLastCalledWith(1000, 'peer_failed');
  });
  it('checks exact lease binding; renewal is not user activity and does not extend the fixed certificate limit', async () => {
    const { connect, hooks, rooms } = fixture(); const { browser, agent } = await connect();
    browser.receive({ type: 'cert_wait' });
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(12_000);
      expect(rooms.renew(2, id, lease, binding, origin).ok).toBe(false);
      expect(rooms.renew(1, id, lease, ticket, origin).ok).toBe(false);
      expect(rooms.renew(1, id, lease, binding, origin).ok).toBe(true);
    }
    expect(hooks.renew).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(6000);
    expect(agent.close).toHaveBeenCalledWith(1000, 'cert_timeout');
  });
  it.each(['idle', 'lease', 'revoke'])('terminates both sockets on %s', async type => {
    const { connect, hooks, rooms } = fixture(); const { agent, browser } = await connect(type === 'idle' ? 20_000 : 0);
    if (type === 'revoke') rooms.invalidate(1, id);
    else await vi.advanceTimersByTimeAsync(type === 'idle' ? 20_000 : 35_000);
    expect(agent.close).toHaveBeenCalledWith(1000, type === 'idle' ? 'idle_timeout' : 'lease_ended');
    expect(browser.close).toHaveBeenCalledOnce(); expect(hooks.release).toHaveBeenCalledOnce();
  });
  it('accepts only bounded data-only SDP with no relay candidates', () => {
    expect(peerSdp(sdp)).toBe(true);
    for (const input of [null, new Uint8Array(1), sdp + 'x'.repeat(13000), sdp + '\u0000', `${sdp}m=audio 9 foo\r\n`, `${sdp}a=candidate:1 1 udp 1 1.2.3.4 12345 typ relay\r\n`]) expect(peerSdp(input)).toBe(false);
  });
});
