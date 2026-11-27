import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../../src/worker/rdp-client/rdp-peer.rdp-text', import.meta.url), 'utf8');
const lease = '00000000-0000-0000-0000-000000000001';
type Stats = Map<string, Record<string, unknown>>;
function reports(id: string, replies: number, seconds: number): Stats {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: id }],
    [id, { type: 'candidate-pair', id, state: 'succeeded', responsesReceived: replies, currentRoundTripTime: seconds,
      localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['not-selected', { type: 'candidate-pair', id: 'not-selected', state: 'succeeded', nominated: true,
      responsesReceived: 3000, currentRoundTripTime: 0.001 }],
    ['local', { candidateType: 'host' }],
    ['remote', { candidateType: 'srflx' }],
  ]);
}

type Carrier = { sampleLink(): Promise<void>; resetLink(): void; close(): void };
async function fixture() {
  const stats = vi.fn<() => Promise<Stats>>();
  const sample = vi.fn();
  const controller = new AbortController();
  const selectedIce = new EventTarget();
  let now = 0;
  const ws = {
    protocol: 'cloudssh-rdp-peer-v2', send: vi.fn(), close: vi.fn(),
    onopen: () => {}, onmessage: (_event: { data: string }) => {},
  };
  const channel = { close: vi.fn(), onmessage: (_event: { data: string }) => {} };
  const window = {} as {
    prepareCloudSshPeerCarrier(url: string, api: string, abi: string, ticket: string, signal: AbortSignal, onSample: typeof sample): Promise<Carrier>;
  };
  runInNewContext(script, {
    window, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, performance: { now: () => now },
    WebSocket: class { constructor() { return ws; } },
    RTCPeerConnection: class {
      iceGatheringState = 'complete';
      localDescription = { sdp: 'offer' };
      sctp = { transport: { iceTransport: selectedIce } };
      createDataChannel() { return channel; }
      async createOffer() { return this.localDescription; }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      getStats = stats;
      close() {}
    },
  });
  const pending = window.prepareCloudSshPeerCarrier('wss://loopback.test', '/api', '5', 'test', controller.signal, sample);
  pending.catch(() => {});
  try {
    ws.onopen();
    ws.onmessage({ data: JSON.stringify({ type: 'paired', lease }) });
    await vi.waitFor(() => expect(ws.send).toHaveBeenLastCalledWith('{"type":"offer","sdp":"offer"}'));
    ws.onmessage({ data: JSON.stringify({ type: 'answer', sdp: 'answer' }) });
    channel.onmessage({ data: JSON.stringify({ type: 'direct_ready', local: 'srflx', remote: 'host' }) });
    const carrier = await pending;
    sample.mockClear();
    return { carrier, stats, sample, selectedIce, advance: (ms: number) => { now += ms; } };
  } catch (error) {
    controller.abort();
    throw error;
  }
}

describe('WebRTC link samples', () => {
  it('uses only new STUN responses of the selected pair and resets when the pair or its counter changes', async () => {
    const { carrier, stats, sample, selectedIce } = await fixture();
    try {
      for (const [id, count, seconds, ms] of [
        ['first', 2, 0.043, null], ['first', 3, 0.044, 44], ['first', 3, 0.700, undefined],
        ['new', 8, 0.120, null], ['new', 9, 0.124, 124], ['new', 1, 0.042, null], ['new', 2, 0.045, 45],
      ] as const) {
        stats.mockResolvedValueOnce(reports(id, count, seconds));
        await carrier.sampleLink();
        expect(sample).toHaveBeenLastCalledWith('host', 'srflx', ms);
      }
      selectedIce.dispatchEvent(new Event('selectedcandidatepairchange'));
      expect(sample).toHaveBeenLastCalledWith(undefined, undefined, null);
      stats.mockResolvedValueOnce(reports('new', 3, 0.046));
      await carrier.sampleLink();
      expect(sample).toHaveBeenLastCalledWith('host', 'srflx', null);
    } finally { carrier.close(); }
  });

  it('does not substitute a nominated pair, missing stats or a nonfinite value', async () => {
    const { carrier, stats, sample } = await fixture();
    try {
      const ambiguous = reports('first', 1, 0.050);
      ambiguous.set('transport2', { type: 'transport', selectedCandidatePairId: 'not-selected' });
      for (const data of [new Map(), ambiguous, reports('first', 2, 0.050), reports('first', 3, Infinity)]) {
        stats.mockResolvedValueOnce(data);
        await carrier.sampleLink();
        expect(sample.mock.lastCall?.[2]).toBeNull();
      }
      stats.mockRejectedValueOnce(new Error('Stats unsupported'));
      await carrier.sampleLink();
      expect(sample).toHaveBeenCalledTimes(4);
    } finally { carrier.close(); }
  });

  it('does not overlap reads or reapply results after hiding or a stalled stats read', async () => {
    const { carrier, stats, sample, advance } = await fixture();
    try {
      stats.mockResolvedValueOnce(reports('first', 1, 0.03));
      await carrier.sampleLink();
      let resolve!: (data: Stats) => void;
      stats.mockReturnValueOnce(new Promise<Stats>(r => { resolve = r; }));
      const old = carrier.sampleLink();
      carrier.resetLink();
      await carrier.sampleLink();
      expect(stats).toHaveBeenCalledTimes(2);
      resolve(reports('first', 2, 0.71));
      await old;
      expect(sample).toHaveBeenCalledTimes(1);

      stats.mockResolvedValueOnce(reports('first', 2, 0.31));
      await carrier.sampleLink();
      expect(sample.mock.lastCall?.[2]).toBeNull();
      stats.mockReturnValueOnce(new Promise<Stats>(r => { resolve = r; }));
      const stalled = carrier.sampleLink();
      advance(5000);
      resolve(reports('first', 3, 0.90));
      await stalled;
      expect(sample).toHaveBeenCalledTimes(2);
      stats.mockResolvedValueOnce(reports('first', 4, 0.04));
      await carrier.sampleLink();
      expect(sample).toHaveBeenLastCalledWith('host', 'srflx', 40);

      advance(15000); // No polls during a long browser suspension, even if visibility did not change.
      stats.mockResolvedValueOnce(reports('first', 5, 0.9));
      await carrier.sampleLink();
      expect(sample).toHaveBeenLastCalledWith('host', 'srflx', null);
    } finally { carrier.close(); }
  });
});
