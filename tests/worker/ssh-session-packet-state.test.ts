/// <reference lib="es2022" />
import { describe, expect, it, vi } from 'vitest';
import { SSHAESCTRCipher, SSHHMAC } from '../../src/ssh/crypto';
import { SSHPacketBuilder } from '../../src/ssh/packet';
import { concat } from '../../src/ssh/utils';
import { SSHSession } from '../../src/worker/ssh-session';

function createSession() {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
  const socket = { close: vi.fn() };
  const session = new SSHSession(ws as unknown as WebSocket, socket as never, {
    host: 'ssh.example.com',
    port: 22,
    username: 'alice',
    password: 'secret',
    authMethod: 'password',
  });
  return { session, ws, socket };
}

describe('SSHSession packet encryption state', () => {
  it.each([
    {
      cipher: 'aes128-gcm@openssh.com',
      mac: 'none',
      expectedAuthTag: true,
      expectedMacLength: 0,
    },
    {
      cipher: 'aes128-ctr',
      mac: 'hmac-sha2-256',
      expectedAuthTag: false,
      expectedMacLength: 32,
    },
  ])(
    'recomputes $cipher framing after a packet enables encryption',
    async ({ cipher, mac, expectedAuthTag, expectedMacLength }) => {
      const { session } = createSession();
      const internal = session as any;
      const decrypt = vi.fn(async (data: Uint8Array) => data);
      const verify = vi.fn(async () => true);
      const nextPacket = vi
        .fn()
        .mockResolvedValueOnce({
          length: 12,
          paddingLength: 10,
          payload: new Uint8Array([21]),
          mac: new Uint8Array(0),
        })
        .mockResolvedValueOnce(null);

      internal.negotiatedCipherS2C = cipher;
      internal.negotiatedMacS2C = mac;
      internal.packetParser = {
        nextPacket,
        getBufferLength: vi.fn(() => 0),
      };
      internal.handlePacket = vi.fn(async () => {
        internal.decryptCipher = { decrypt };
        internal.decryptMac = expectedMacLength > 0 ? { verify } : null;
      });

      await internal.processPackets();

      expect(nextPacket).toHaveBeenCalledTimes(2);
      expect(nextPacket.mock.calls[0][0]).toBe(8);
      expect(nextPacket.mock.calls[0][2]).toBe(false);
      expect(nextPacket.mock.calls[0][3]).toBe(0);

      const [blockSize, decryptPacket, hasAuthTag, macLength, verifyMac] = nextPacket.mock.calls[1];
      expect(blockSize).toBe(16);
      expect(hasAuthTag).toBe(expectedAuthTag);
      expect(macLength).toBe(expectedMacLength);
      expect(typeof decryptPacket).toBe('function');
      expect(typeof verifyMac === 'function').toBe(expectedMacLength > 0);
    }
  );

  it('parses NEWKEYS and the first CTR/HMAC packet from one TCP chunk', async () => {
    const { session, ws, socket } = createSession();
    const internal = session as any;
    const keys = {
      ivClientToServer: new Uint8Array(16).fill(0x11),
      ivServerToClient: new Uint8Array(16).fill(0x22),
      encKeyClientToServer: new Uint8Array(16).fill(0x33),
      encKeyServerToClient: new Uint8Array(16).fill(0x44),
      integrityKeyC2S: new Uint8Array(32).fill(0x55),
      integrityKeyS2C: new Uint8Array(32).fill(0x66),
      sessionID: new Uint8Array(32).fill(0x77),
    };

    internal.state = 'kex';
    internal.derivedKeys = keys;
    internal.negotiatedCipherC2S = 'aes128-ctr';
    internal.negotiatedCipherS2C = 'aes128-ctr';
    internal.negotiatedMacC2S = 'hmac-sha2-256';
    internal.negotiatedMacS2C = 'hmac-sha2-256';
    internal.writeSocket = vi.fn(async () => {});
    const handlePacket = vi.spyOn(internal, 'handlePacket');

    const serverCipher = new SSHAESCTRCipher(keys.encKeyServerToClient, keys.ivServerToClient);
    const serverMac = new SSHHMAC('hmac-sha2-256', keys.integrityKeyS2C);
    await serverCipher.init();
    await serverMac.init();

    const newKeysPacket = await SSHPacketBuilder.build(new Uint8Array([21]), 8, null, 0);
    const extInfoPacket = await SSHPacketBuilder.build(
      new Uint8Array([7, 0, 0, 0, 0]),
      16,
      (data, seq, aad) => serverCipher.encrypt(data, seq, aad),
      1,
      false,
      (packet, seq) => serverMac.sign(packet, seq)
    );

    internal.packetParser.feed(concat(newKeysPacket, extInfoPacket));
    await internal.processPackets();

    expect(handlePacket).toHaveBeenCalledTimes(2);
    expect(handlePacket.mock.calls.map(([packet]: any[]) => packet.payload[0])).toEqual([21, 7]);
    expect(internal.packetParser.getBufferLength()).toBe(0);
    expect(internal.state).toBe('auth');
    expect(ws.close).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
});
