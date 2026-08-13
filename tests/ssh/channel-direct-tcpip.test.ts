import { describe, expect, it } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import { SSH_MSG_CHANNEL_OPEN } from '../../src/types';

function readUint32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, false);
}

function readString(data: Uint8Array, offset: number): { value: string; next: number } {
  const length = readUint32(data, offset);
  const start = offset + 4;
  return {
    value: new TextDecoder().decode(data.subarray(start, start + length)),
    next: start + length,
  };
}

describe('SSHChannel direct-tcpip', () => {
  it('按照 RFC 4254 编码目标和来源地址', () => {
    const channel = new SSHChannel();
    const packet = channel.buildOpenDirectTcpip(7, '10.0.0.8', 2222, '127.0.0.1', 54321);

    expect(packet[0]).toBe(SSH_MSG_CHANNEL_OPEN);
    const type = readString(packet, 1);
    expect(type.value).toBe('direct-tcpip');
    expect(readUint32(packet, type.next)).toBe(7);
    expect(readUint32(packet, type.next + 4)).toBe(2_097_152);
    expect(readUint32(packet, type.next + 8)).toBe(32_768);

    const host = readString(packet, type.next + 12);
    expect(host.value).toBe('10.0.0.8');
    expect(readUint32(packet, host.next)).toBe(2222);
    const origin = readString(packet, host.next + 4);
    expect(origin.value).toBe('127.0.0.1');
    expect(readUint32(packet, origin.next)).toBe(54321);
    expect(origin.next + 4).toBe(packet.length);
  });
});
