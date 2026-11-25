import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSHAESGCMCipher } from '../../src/ssh/crypto';
import { SSHPacketBuilder, SSHPacketParser } from '../../src/ssh/packet';
import { concat, encodeString, encodeUint32 } from '../../src/ssh/utils';
import type { SSHPacket } from '../../src/types';
import { SSHSession } from '../../src/worker/ssh-session';

const sessions: SSHSession[] = [];
const tickMs = 25_000;
const ignore = Uint8Array.of(2, 0, 0, 0, 0);
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.close(true);
  vi.useRealTimers();
});

interface Frame {
  type: string;
  latency?: number;
  colo?: string;
  event?: string;
  message?: string;
}

function browserSocket() {
  const messages: Frame[] = [];
  return {
    readyState: WebSocket.OPEN,
    send: (s: string) => messages.push(JSON.parse(s)),
    close: vi.fn(),
    messages,
  };
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function unimplemented(sequence: number): Uint8Array {
  return concat(Uint8Array.of(3), encodeUint32(sequence));
}

// Start just after authentication. Keep the real send mutex, packet builder, encrypted
// socket reads/writes and timers. The peer counts packets independently of SSHSession.
async function createPeer(options: {
  firstSequence?: number;
  ownsWebSocket?: boolean;
  debug?: boolean;
} = {}) {
  const cipher = async (key: number) => {
    const result = new SSHAESGCMCipher(new Uint8Array(16).fill(key), new Uint8Array(12));
    await result.init();
    return result;
  };
  const [tx, peerRx, peerTx, rx] = await Promise.all([cipher(1), cipher(1), cipher(2), cipher(2)]);
  const ws = browserSocket();
  const onRtt = vi.fn();
  const onWrite = vi.fn<(seq: number, payload: Uint8Array) => Promise<void> | void>();
  const peerParser = new SSHPacketParser();
  let peerSequence = options.firstSequence ?? 19;
  let replySequence = 0;
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const socket = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      async write(bytes) {
        peerParser.feed(bytes);
        const packet = await peerParser.nextPacket(16, peerRx.decrypt.bind(peerRx), true);
        if (!packet) throw new Error('Incomplete packet on test socket');
        const sequence = peerSequence;
        peerSequence = (peerSequence + 1) >>> 0;
        await onWrite(sequence, packet.payload);
      },
    }),
    close: vi.fn(() => input.close()),
  };
  const session = new SSHSession(
    ws,
    socket,
    { host: 'example.test', port: 22, username: 'test', password: '', authMethod: 'none' },
    options.debug,
    undefined,
    undefined,
    undefined,
    undefined,
    { ownsWebSocket: options.ownsWebSocket, colo: 'HKG', onRttUpdated: onRtt }
  );
  sessions.push(session);
  const io = session as unknown as {
    state: string;
    encryptCipher: SSHAESGCMCipher;
    decryptCipher: SSHAESGCMCipher;
    seqNumSend: number;
    startReading(): Promise<void>;
    startKeepalive(): void;
    handlePacket(p: SSHPacket): Promise<void>;
    sendEncrypted(payload: Uint8Array): Promise<void>;
    sendMutex: Promise<void>;
  };
  io.state = options.ownsWebSocket === false ? 'tunnel-ready' : 'ready';
  io.encryptCipher = tx;
  io.decryptCipher = rx;
  io.seqNumSend = peerSequence;
  let consumed: (() => void) | undefined;
  const handle = io.handlePacket.bind(session);
  io.handlePacket = async (packet) => {
    await handle(packet);
    consumed?.();
    consumed = undefined;
  };
  const reading = io.startReading();
  io.startKeepalive();

  async function reply(payload: Uint8Array) {
    const packet = await SSHPacketBuilder.build(
      payload, 16, peerTx.encrypt.bind(peerTx), replySequence++, true
    );
    const handled = new Promise<void>((resolve) => {
      consumed = resolve;
    });
    input.enqueue(packet);
    await handled;
  }
  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await io.sendMutex;
  }
  return { session, io, ws, socket, onRtt, onWrite, advance, reply, reading };
}

describe('SSH keepalive RTT and delivery', () => {
  it.each([81, 82])('standard response %d publishes exactly one RTT', async (type) => {
    const peer = await createPeer();
    await peer.advance(25_000);
    await peer.advance(42);
    await peer.reply(Uint8Array.of(type));
    await peer.reply(Uint8Array.of(type));
    expect(peer.onRtt.mock.calls).toEqual([[42, 'HKG']]);
    expect(peer.ws.messages.filter((m) => m.type === 'rtt')).toEqual([
      { type: 'rtt', latency: 42, colo: 'HKG' },
    ]);
  });

  it.each(['jump', 'detached'])('%s updates only the baseline RTT', async (kind) => {
    const peer = await createPeer({ ownsWebSocket: kind !== 'jump' });
    if (kind === 'detached') peer.session.setDetached(true);
    await peer.advance(25_000);
    await peer.advance(30);
    await peer.reply(unimplemented(peer.onWrite.mock.calls[0][0]));
    expect(peer.onRtt.mock.calls).toEqual([[30, 'HKG']]);
    expect(peer.ws.messages.filter((m) => m.type === 'rtt')).toEqual([]);
  });

  it('sends the baseline and subsequent RTT to the reattached socket only', async () => {
    const peer = await createPeer();
    const replacement = browserSocket();
    await peer.session.reattachWebSocket(replacement as unknown as WebSocket, null, {
      baseline: { latencyMs: 50, colo: 'NRT' },
    });
    await peer.advance(25_000);
    await peer.advance(35);
    await peer.reply(Uint8Array.of(82));
    expect(replacement.messages.filter((m) => m.type === 'rtt')).toEqual([
      { type: 'rtt', latency: 50, colo: 'NRT' },
      { type: 'rtt', latency: 35, colo: 'NRT' },
    ]);
    expect(peer.ws.messages.filter((m) => m.type === 'rtt')).toEqual([]);
  });
});

describe('SSH keepalive compatibility (#211)', () => {
  it('stays online for three minutes without renewing user activity', async () => {
    const peer = await createPeer({ debug: true });
    const lastActivity = peer.session.getLastUserActivityAt();
    const expected = concat(
      Uint8Array.of(80), encodeString('keepalive@openssh.com'), Uint8Array.of(1)
    );
    for (let i = 0; i < 7; i++) {
      await peer.advance(i === 0 ? tickMs : tickMs - 50);
      const [sequence, payload] = peer.onWrite.mock.calls[i];
      expect(payload).toEqual(expected);
      await peer.advance(50);
      await peer.reply(unimplemented(sequence));
    }
    await peer.advance(4_950);
    expect(peer.onWrite).toHaveBeenCalledTimes(7);
    expect(peer.onRtt.mock.calls).toEqual(Array(7).fill([50, 'HKG']));
    expect(peer.ws.messages.map((m) => m.message)).toContain('Keepalive UNIMPLEMENTED matched seq=19');
    expect(peer.session.getLastUserActivityAt()).toBe(lastActivity);
    expect(peer.ws.close).not.toHaveBeenCalled();
  });

  it('matches early replies across queued writes and uint32 wrap', async () => {
    const peer = await createPeer({ firstSequence: 0xfffffffd });
    const started = gate();
    const blocked = gate();
    peer.onWrite.mockImplementationOnce(() => {
      started.release();
      return blocked.wait;
    });
    const first = peer.io.sendEncrypted(ignore);
    await started.wait;
    const second = peer.io.sendEncrypted(ignore); // Not yet built when the keepalive is enqueued.
    await vi.advanceTimersByTimeAsync(2 * tickMs + 1);
    await peer.reply(unimplemented(0xffffffff)); // No packet has been written for this probe yet.
    await peer.reply(Uint8Array.of(82));
    expect(peer.onRtt).not.toHaveBeenCalled();
    expect(peer.onWrite).toHaveBeenCalledTimes(1);
    peer.onWrite.mockImplementation(async (seq, payload) => {
      if (payload[0] === 80) await peer.reply(unimplemented(seq)); // write still pending
    });
    blocked.release();
    await Promise.all([first, second, peer.io.sendMutex]);
    await peer.advance(tickMs - 1);
    expect(peer.onWrite.mock.calls.map(([seq, p]) => [seq, p[0]])).toEqual([
      [0xfffffffd, 2], [0xfffffffe, 2], [0xffffffff, 80], [0, 80],
    ]);
    // Neither queued time nor a phantom response deadline should affect RTT.
    expect(peer.onRtt.mock.calls).toEqual([[0, 'HKG'], [0, 'HKG']]);
    expect(peer.ws.close).not.toHaveBeenCalled();
  });

  it('does not accept unrelated, stale, duplicate or malformed UNIMPLEMENTED packets', async () => {
    const peer = await createPeer({ firstSequence: 0 });
    await peer.reply(unimplemented(0)); // Unsolicited, before the first tick.
    await peer.advance(tickMs);
    await peer.reply(Uint8Array.of(3)); // Must not decode a missing field as sequence zero.
    await peer.reply(concat(unimplemented(0), Uint8Array.of(0)));
    expect(peer.onRtt).not.toHaveBeenCalled();
    await peer.reply(unimplemented(0));
    await peer.reply(unimplemented(0)); // Already settled.
    for (const wrong of [0, 1, 0xffffffff]) {
      await peer.advance(tickMs);
      await peer.reply(unimplemented(wrong));
    }
    await peer.advance(10_000);
    expect(peer.onRtt).toHaveBeenCalledTimes(1);
    expect(peer.ws.messages.filter((m) => m.type === 'error').map((m) => m.event)).toEqual([
      'keepalive_timeout',
    ]);
    expect(peer.ws.close.mock.calls).toEqual([[1011]]);
  });

  it('a matched rejection resets consecutive failures', async () => {
    const peer = await createPeer();
    for (const shouldReply of [false, false, true, false, false, true]) {
      await peer.advance(tickMs);
      const seq = peer.onWrite.mock.calls.at(-1)![0];
      await peer.reply(shouldReply ? unimplemented(seq) : ignore);
    }
    expect(peer.ws.close).not.toHaveBeenCalled();
    expect(peer.onRtt).toHaveBeenCalledTimes(2);
  });

  it('never abandons the independent inbound watchdog on a silent connection', async () => {
    const peer = await createPeer();
    for (let i = 0; i < 7; i++) await peer.advance(10_000);
    expect(peer.ws.messages.filter((m) => m.type === 'error').map((m) => m.event)).toEqual([
      'idle_timeout',
    ]);
    expect(peer.ws.close.mock.calls).toEqual([[1011]]);
    await peer.reading;
  });

  it('charges each write failure once and never waits for a reply to a failed write', async () => {
    const peer = await createPeer({ debug: true });
    peer.onWrite.mockRejectedValue(new Error('test write failure'));
    for (let i = 0; i < 3; i++) {
      await peer.reply(ignore); // Keep the independent read watchdog alive.
      await peer.advance(tickMs);
    }
    const failures = peer.ws.messages.filter((m) => m.message?.startsWith('Keepalive send failed'));
    expect(failures.map((m) => m.message)).toEqual([
      'Keepalive send failed (1/3)', 'Keepalive send failed (2/3)', 'Keepalive send failed (3/3)',
    ]);
    expect(peer.ws.close.mock.calls).toEqual([[1011]]);
  });

  it.each(['queued', 'writing', 'waiting'])('close while %s discards the probe', async (phase) => {
    const peer = await createPeer();
    const started = gate();
    const blocked = gate();
    if (phase !== 'waiting') {
      peer.onWrite.mockImplementationOnce(() => {
        started.release();
        return blocked.wait;
      });
    }
    // For the queued case, hold the lock with a different packet before the first tick.
    const prior = phase === 'queued' ? peer.io.sendEncrypted(ignore) : undefined;
    if (phase === 'queued') await started.wait;
    await vi.advanceTimersByTimeAsync(tickMs);
    if (phase === 'writing') await started.wait;
    if (phase === 'waiting') await peer.io.sendMutex;
    const drained = peer.io.sendMutex;
    peer.session.close(true);
    blocked.release();
    await Promise.all([peer.reading, prior, drained]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(peer.ws.close.mock.calls).toEqual([[1000]]);
    expect(peer.onWrite).toHaveBeenCalledTimes(1);
    expect(peer.onRtt).not.toHaveBeenCalled();
    expect(peer.ws.messages.filter((m) => m.type === 'error')).toEqual([]);
  });
});
