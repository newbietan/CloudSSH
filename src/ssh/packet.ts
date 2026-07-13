import { SSHPacket } from '../types';
import { readUint32, writeUint32 } from './utils';

const EMPTY_BUFFER = new Uint8Array(0);
const COMPACT_CHUNKS_THRESHOLD = 32;
const MAX_PACKET_SIZE = 256 * 1024; // 256KB — RFC 4253 §6.1 requires at least 35000 bytes

export class SSHPacketParser {
  private chunks: Uint8Array[] = [];
  private chunkIndex: number = 0;
  private readOffset: number = 0;
  private bufferedLength: number = 0;
  private seqNum: number = 0;

  feed(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }

    this.chunks.push(data);
    this.bufferedLength += data.length;
  }

  private peekBytes(bytes: number): Uint8Array | null {
    if (bytes === 0) {
      return EMPTY_BUFFER;
    }

    if (this.bufferedLength < bytes) {
      return null;
    }

    const first = this.chunks[this.chunkIndex];
    if (first) {
      const firstAvailable = first.length - this.readOffset;
      if (firstAvailable >= bytes) {
        return first.subarray(this.readOffset, this.readOffset + bytes);
      }
    }

    const result = new Uint8Array(bytes);
    let copied = 0;

    for (let i = this.chunkIndex; copied < bytes; i++) {
      const chunk = this.chunks[i];
      const start = i === this.chunkIndex ? this.readOffset : 0;
      const take = Math.min(chunk.length - start, bytes - copied);
      result.set(chunk.subarray(start, start + take), copied);
      copied += take;
    }

    return result;
  }

  private readBytes(bytes: number): Uint8Array | null {
    const result = this.peekBytes(bytes);
    if (!result) {
      return null;
    }

    this.consumeBytes(bytes);
    return result;
  }

  private consumeBytes(bytes: number): void {
    if (bytes === 0) {
      return;
    }

    if (bytes > this.bufferedLength) {
      throw new Error('Cannot consume more bytes than buffered');
    }

    this.bufferedLength -= bytes;

    while (bytes > 0) {
      const chunk = this.chunks[this.chunkIndex];
      const available = chunk.length - this.readOffset;

      if (bytes < available) {
        this.readOffset += bytes;
        this.compactChunks();
        return;
      }

      bytes -= available;
      this.chunkIndex++;
      this.readOffset = 0;
    }

    this.compactChunks();
  }

  private compactChunks(): void {
    if (this.bufferedLength === 0) {
      this.chunks = [];
      this.chunkIndex = 0;
      this.readOffset = 0;
      return;
    }

    // Discard fully consumed chunks (Array.slice creates a new reference array,
    // not a Uint8Array copy — this is intentional to free old chunk objects)
    if (
      this.chunkIndex > COMPACT_CHUNKS_THRESHOLD &&
      this.chunkIndex * 2 >= this.chunks.length
    ) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
  }

  async nextPacket(blockSize: number, decrypt: (
    data: Uint8Array, seq: number, aad?: Uint8Array, commit?: boolean
  ) => Uint8Array | Promise<Uint8Array | null> | null, hasAuthTag: boolean = false,
  macLength: number = 0,
  verifyMac?: (packet: Uint8Array, mac: Uint8Array, seq: number) => boolean | Promise<boolean>): Promise<SSHPacket | null> {
    if (hasAuthTag) {
      const lengthBytes = this.peekBytes(4);
      if (!lengthBytes) return null;

      const packetLength = readUint32(lengthBytes, 0);
      if (packetLength > MAX_PACKET_SIZE) {
        throw new Error(`Packet length ${packetLength} exceeds maximum allowed size ${MAX_PACKET_SIZE}`);
      }
      const expectedSize = 4 + packetLength + 16;

      if (this.bufferedLength < expectedSize) return null;

      const raw = this.readBytes(expectedSize);
      if (!raw) return null;

      const lengthField = raw.subarray(0, 4);
      const dataToDecrypt = raw.subarray(4);
      const decrypted = await decrypt(dataToDecrypt, this.seqNum, lengthField, true);
      if (!decrypted) return null;

      const paddingLength = decrypted[0];
      if (paddingLength < 4 || paddingLength >= packetLength) {
        throw new Error(`Invalid padding length ${paddingLength} for packet length ${packetLength}`);
      }
      const payload = decrypted.subarray(1, 1 + packetLength - 1 - paddingLength);

      this.seqNum++;

      return {
        length: packetLength,
        paddingLength,
        payload,
        mac: raw.subarray(4 + packetLength),
      };
    }

    const encryptedHeader = this.peekBytes(blockSize);
    if (!encryptedHeader) return null;

    const header = await decrypt(
      encryptedHeader, this.seqNum, undefined, false
    );
    if (!header) return null;

    const packetLength = readUint32(header, 0);
    if (packetLength > MAX_PACKET_SIZE) {
      throw new Error(`Packet length ${packetLength} exceeds maximum allowed size ${MAX_PACKET_SIZE}`);
    }

    const totalBlocks = Math.ceil((4 + packetLength) / blockSize);
    const totalSize = totalBlocks * blockSize;

    if (this.bufferedLength < totalSize + macLength) return null;

    const encryptedPacket = this.readBytes(totalSize);
    const mac = this.readBytes(macLength);
    if (!encryptedPacket || !mac) return null;

    const decrypted = await decrypt(encryptedPacket, this.seqNum, undefined, true);
    if (!decrypted) return null;

    if (verifyMac && macLength > 0) {
      const macValid = await verifyMac(decrypted, mac, this.seqNum);
      if (!macValid) {
        throw new Error('Invalid packet MAC');
      }
    }

    const paddingLength = decrypted[4];
    if (paddingLength < 4 || paddingLength >= packetLength) {
      throw new Error(`Invalid padding length ${paddingLength} for packet length ${packetLength}`);
    }
    const payload = decrypted.subarray(5, 5 + packetLength - 1 - paddingLength);

    this.seqNum++;

    return {
      length: packetLength,
      paddingLength,
      payload,
      mac,
    };
  }

  getSeqNum(): number {
    return this.seqNum;
  }

  resetSeqNum(): void {
    this.seqNum = 0;
  }

  getBufferLength(): number {
    return this.bufferedLength;
  }
}

export class SSHPacketBuilder {
  static async build(
    payload: Uint8Array,
    blockSize: number,
    encrypt: ((data: Uint8Array, seq: number, aad?: Uint8Array) => Uint8Array | Promise<Uint8Array>) | null,
    seqNum: number,
    hasAuthTag: boolean = false,
    mac?: (packet: Uint8Array, seq: number) => Uint8Array | Promise<Uint8Array>
  ): Promise<Uint8Array> {
    return SSHPacketBuilder.buildWithPayloadWriter(
      payload.length,
      (packet, offset) => packet.set(payload, offset),
      blockSize,
      encrypt,
      seqNum,
      hasAuthTag,
      mac
    );
  }

  static async buildWithPayloadWriter(
    payloadLength: number,
    writePayload: (packet: Uint8Array, offset: number) => void,
    blockSize: number,
    encrypt: ((data: Uint8Array, seq: number, aad?: Uint8Array) => Uint8Array | Promise<Uint8Array>) | null,
    seqNum: number,
    hasAuthTag: boolean = false,
    mac?: (packet: Uint8Array, seq: number) => Uint8Array | Promise<Uint8Array>
  ): Promise<Uint8Array> {
    const packetLength = 1 + payloadLength;
    // For AES-GCM (hasAuthTag), padding aligns the encrypted portion
    // (padding_length + payload + padding) to blockSize.
    // The 4-byte packet_length is AAD, NOT part of the encrypted data.
    // For non-GCM, padding aligns the full packet (4 + data) to blockSize.
    const alignBase = hasAuthTag
      ? (1 + payloadLength) % blockSize      // encrypted portion only
      : (4 + packetLength) % blockSize;        // full packet including length
    const paddingNeeded = blockSize - (alignBase || blockSize);
    const paddingLength = paddingNeeded < 4
      ? paddingNeeded + blockSize
      : paddingNeeded;

    const totalLength = 4 + 1 + payloadLength + paddingLength;
    const packet = new Uint8Array(totalLength);

    const pl = 1 + payloadLength + paddingLength;
    writeUint32(packet, 0, pl);

    packet[4] = paddingLength;

    writePayload(packet, 5);

    crypto.getRandomValues(packet.subarray(5 + payloadLength));

    if (encrypt) {
      if (hasAuthTag) {
        const lengthField = packet.subarray(0, 4);
        const dataToEncrypt = packet.subarray(4);
        const encryptedData = await encrypt(dataToEncrypt, seqNum, lengthField);
        const result = new Uint8Array(4 + encryptedData.length);
        result.set(lengthField, 0);
        result.set(encryptedData, 4);
        return result;
      }
      const encryptedPacket = await encrypt(packet, seqNum);
      if (mac) {
        const macBytes = await mac(packet, seqNum);
        const result = new Uint8Array(encryptedPacket.length + macBytes.length);
        result.set(encryptedPacket, 0);
        result.set(macBytes, encryptedPacket.length);
        return result;
      }
      return encryptedPacket;
    }

    return packet;
  }
}
