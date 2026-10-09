import { describe, expect, it } from 'vitest';
import { SSH_CHANNEL_MAX_PACKET_SIZE, SSHChannel } from '../../src/ssh/channel';
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
    expect(readUint32(packet, type.next + 8)).toBe(SSH_CHANNEL_MAX_PACKET_SIZE);
    expect(SSH_CHANNEL_MAX_PACKET_SIZE).toBe(16_384);

    const host = readString(packet, type.next + 12);
    expect(host.value).toBe('10.0.0.8');
    expect(readUint32(packet, host.next)).toBe(2222);
    const origin = readString(packet, host.next + 4);
    expect(origin.value).toBe('127.0.0.1');
    expect(readUint32(packet, origin.next)).toBe(54321);
    expect(origin.next + 4).toBe(packet.length);
  });

  it('buildOpenSession 声明 16384 (16KB) 安全最大包长度', () => {
    const channel = new SSHChannel();
    const packet = channel.buildOpenSession(0);
    expect(packet[0]).toBe(SSH_MSG_CHANNEL_OPEN);
    const type = readString(packet, 1);
    expect(type.value).toBe('session');
    expect(readUint32(packet, type.next)).toBe(0);
    expect(readUint32(packet, type.next + 4)).toBe(2_097_152);
    expect(readUint32(packet, type.next + 8)).toBe(16_384);
  });

  it('takeChannelDataChunk 单包载荷严格被限制在 16384 字节内', () => {
    const channel = new SSHChannel();
    // 模拟远端确认，远端窗口 1MB，远端最大包 32768
    const confirmPayload = new Uint8Array(17);
    confirmPayload[0] = 91; // SSH_MSG_CHANNEL_OPEN_CONFIRMATION
    // localChannelID = 0
    new DataView(confirmPayload.buffer).setUint32(1, 0, false);
    // remoteChannelID = 1
    new DataView(confirmPayload.buffer).setUint32(5, 1, false);
    // remoteWindowSize = 1048576
    new DataView(confirmPayload.buffer).setUint32(9, 1048576, false);
    // serverMaxPacket = 32768
    new DataView(confirmPayload.buffer).setUint32(13, 32768, false);

    channel.handleOpenConfirmation(confirmPayload);

    // 虽然服务端宣告 32768，但客户端本端上限保持 16384
    expect(channel.getMaxPacketSize()).toBe(16_384);

    // 尝试切分一个 64KB 大数据块
    const largeData = new Uint8Array(65536);
    const chunk1 = channel.takeChannelDataChunk(largeData, 0);
    expect(chunk1).not.toBeNull();
    expect(chunk1!.bytesConsumed).toBe(16_384);
    expect(chunk1!.payloadLength).toBe(9 + 16_384);

    const chunk2 = channel.takeChannelDataChunk(largeData, chunk1!.bytesConsumed);
    expect(chunk2).not.toBeNull();
    expect(chunk2!.bytesConsumed).toBe(16_384);
  });
});
