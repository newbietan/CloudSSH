import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RdpPeerRooms } from '../../src/worker/rdp-peer-rooms';

const id='00000001-0000-0000-0000-000000000000', lease='00000002-0000-0000-0000-000000000000';
const binding='a'.repeat(64), digest='b'.repeat(64), ticket='c'.repeat(64);
const sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 00:00\r\n';
class Socket extends EventTarget {
  accept() {} send=vi.fn(); close=vi.fn();
  receive(data: unknown){this.dispatchEvent(new MessageEvent('message',{data: data instanceof ArrayBuffer || typeof data==='string' ? data : JSON.stringify(data)}));}
}
let database: DatabaseSync;
function fixture() {
  vi.useFakeTimers(); database=new DatabaseSync(':memory:');
  const db = { exec(q:string,...args:(string|number)[]){ const s=database.prepare(q);
    return q.startsWith('SELECT')?{toArray:()=>s.all(...args)}:{rowsWritten:s.run(...args).changes}; } } as unknown as SqlStorage;
  database.exec(`CREATE TABLE rdp_profiles(user_id INTEGER,id TEXT,revision INTEGER,fingerprint TEXT); CREATE TABLE rdp_profile_options(user_id INTEGER,profile TEXT,login TEXT)`);
  database.prepare('INSERT INTO rdp_profiles VALUES(1,?,2,?)').run(id,digest);database.prepare('INSERT INTO rdp_profile_options VALUES(1,?,?)').run(id,'encrypted');
  const sockets:Socket[]=[];vi.stubGlobal('WebSocketPair',class{0={};1=new Socket();constructor(){sockets.push(this[1])}});
  const NativeResponse=Response;
  vi.stubGlobal('Response',class extends NativeResponse{constructor(body?:BodyInit|null, init?:ResponseInit){super(body,init?.status===101?{status:200}:init)}});
  const hooks={claim:vi.fn(async()=>({lease,profile:id,revision:2})),record:vi.fn(()=>true),release:vi.fn(),renew:vi.fn(()=>true)};
  const rooms=new RdpPeerRooms(db,hooks);
  const pair=()=>rooms.prepare(1,id,2,binding,digest);
  const attach=async(idle=0)=>{ expect(pair().ok).toBe(true);expect(rooms.agent(1,id,digest).ok).toBe(true);rooms.browser(1,binding,idle);
    const [agent,browser]=sockets;browser.receive({type:'ticket',ticket});await vi.advanceTimersByTimeAsync(0);
    expect(browser.send).toHaveBeenLastCalledWith(JSON.stringify({type:'paired',lease}));
    browser.receive({type:'offer',sdp});agent.receive({type:'answer',sdp});agent.receive({type:'connected'});return {agent,browser}; };
  return {rooms,hooks,pair,attach,sockets};
}
afterEach(()=>{database?.close();vi.unstubAllGlobals();vi.useRealTimers()});
describe('direct-only control rendezvous',()=>{
  it('requires owner, current revision, prior trust, a one-use proof; an old cancel cannot kill a replacement',()=>{
    const {rooms,pair}=fixture();
    expect(rooms.prepare(2,id,2,binding,digest).ok).toBe(false);expect(rooms.prepare(1,id,1,binding,digest).ok).toBe(false);
    database.exec("UPDATE rdp_profiles SET fingerprint=''");expect(pair().ok).toBe(false);
    database.prepare('UPDATE rdp_profiles SET fingerprint=?').run(digest);expect(pair().ok).toBe(true);
    expect(rooms.agent(1,id,ticket).ok).toBe(false);rooms.cancelWaiting(1,id,binding,ticket);
    expect(rooms.agent(1,id,digest).ok).toBe(true);rooms.cancelWaiting(1,id,ticket,digest);
    expect(pair().ok).toBe(false);rooms.cancelWaiting(1,id,binding,digest);expect(rooms.agent(1,id,digest).ok).toBe(false);
    expect(pair().ok).toBe(true);vi.advanceTimersByTime(300001);expect(rooms.agent(1,id,digest).ok).toBe(false);
  });
  it('does not attach a browser with a different cookie, and releases the rejected lease',async()=>{
    const {rooms,pair,sockets,hooks}=fixture();pair();rooms.agent(1,id,digest);rooms.browser(1,ticket,0);sockets[1].receive({type:'ticket',ticket});await vi.advanceTimersByTimeAsync(0);
    expect(sockets[1].close).toHaveBeenCalledWith(1000,'peer_unavailable');expect(hooks.release).toHaveBeenCalledWith(1,lease);expect(sockets[0].send).toHaveBeenCalledTimes(1);
  });
  it.each(['agent','browser'] as const)('never forwards binary on the %s signaling websocket',async side=>{
    const {attach,hooks}=fixture();const endpoints=await attach(); const {agent}=endpoints;
    endpoints[side].receive(new ArrayBuffer(16)); await vi.advanceTimersByTimeAsync(0);
    expect(agent.close).toHaveBeenCalledWith(1000,'peer_failed');expect(hooks.release).toHaveBeenCalledOnce();
    expect(agent.send.mock.calls.every(([data])=>typeof data==='string')).toBe(true);
  });
  it('checks the browser binding and the live lease on renewal; stats and renewals do not refresh idle',async()=>{
    const {attach,hooks,rooms}=fixture();const {browser,agent}=await attach(20000);
    browser.receive({type:'desktop_ready'});expect(hooks.record).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);expect(rooms.renew(2,id,lease,binding).ok).toBe(false);expect(rooms.renew(1,id,lease,ticket).ok).toBe(false);
    expect(rooms.renew(1,id,lease,binding).ok).toBe(true);expect(hooks.renew).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);expect(agent.close).toHaveBeenCalledWith(1000,'idle_timeout');
    expect(rooms.renew(1,id,lease,binding).ok).toBe(false);
  });
  it('ends both paths without fresh authorization even under input',async()=>{
    const {attach,hooks}=fixture();const {browser,agent}=await attach();await vi.advanceTimersByTimeAsync(34000);browser.receive({type:'activity'});
    await vi.advanceTimersByTimeAsync(1000);expect(agent.close).toHaveBeenCalledWith(1000,'lease_ended');expect(browser.close).toHaveBeenCalledOnce();expect(hooks.release).toHaveBeenCalledOnce();
  });
});
