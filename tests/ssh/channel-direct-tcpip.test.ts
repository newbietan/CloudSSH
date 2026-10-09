import { describe, expect, it } from 'vitest';
import {
  SSH_CHANNEL_DEFAULT_MAX_PACKET_SIZE,
  SSH_CHANNEL_TUNNEL_MAX_PACKET_SIZE,
  SSHChannel,
} from '../../src/ssh/channel';
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
    expect(readUint32(packet, type.next + 8)).toBe(SSH_CHANNEL_DEFAULT_MAX_PACKET_SIZE);
    expect(SSH_CHANNEL_DEFAULT_MAX_PACKET_SIZE).toBe(32_768);
    expect(SSH_CHANNEL_TUNNEL_MAX_PACKET_SIZE).toBe(16_384);

    const host = readString(packet, type.next + 12);
    expect(host.value).toBe('10.0.0.8');
    expect(readUint32(packet, host.next)).toBe(2222);
    const origin = readString(packet, host.next + 4);
    expect(origin.value).toBe('127.0.0.1');
    expect(readUint32(packet, origin.next)).toBe(54321);
    expect(origin.next + 4).toBe(packet.length);
  });

  it('默认 buildOpenSession 声明 32768 (32KB) 满血直连包长', () => {
    const channel = new SSHChannel();
    const packet = channel.buildOpenSession(0);
    expect(packet[0]).toBe(SSH_MSG_CHANNEL_OPEN);
    const type = readString(packet, 1);
    expect(type.value).toBe('session');
    expect(readUint32(packet, type.next)).toBe(0);
    expect(readUint32(packet, type.next + 4)).toBe(2_097_152);
    expect(readUint32(packet, type.next + 8)).toBe(32_768);
  });

  it('隧道模式 SSHChannel 声明 16384 (16KB) 特化安全最大包长并约束分片', () => {
    const tunnelChannel = new SSHChannel(SSH_CHANNEL_TUNNEL_MAX_PACKET_SIZE);
    const packet = tunnelChannel.buildOpenSession(1);
    const type = readString(packet, 1);
    expect(readUint32(packet, type.next + 8)).toBe(16_384);

    // 模拟服务端确认
    const confirmPayload = new Uint8Array(17);
    confirmPayload[0] = 91;
    new DataView(confirmPayload.buffer).setUint32(1, 1, false);
    new DataView(confirmPayload.buffer).setUint32(5, 1, false);
    new DataView(confirmPayload.buffer).setUint32(9, 1048576, false);
    new DataView(confirmPayload.buffer).setUint32(13, 32768, false);

    tunnelChannel.handleOpenConfirmation(confirmPayload);
    expect(tunnelChannel.getMaxPacketSize()).toBe(16_384);

    const largeData = new Uint8Array(65536);
    const chunk1 = tunnelChannel.takeChannelDataChunk(largeData, 0);
    expect(chunk1).not.toBeNull();
    expect(chunk1!.bytesConsumed).toBe(16_384);
  });
});
