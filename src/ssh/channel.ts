import {
  SSH_MSG_CHANNEL_OPEN,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_REQUEST
} from '../types';
import { encodeString, readUint32, writeUint32 } from './utils';

const SESSION_FIELD = encodeString('session');
const PTY_REQ_FIELD = encodeString('pty-req');
const SHELL_FIELD = encodeString('shell');
const XTERM_256COLOR_FIELD = encodeString('xterm-256color');
const WINDOW_CHANGE_FIELD = encodeString('window-change');
const EMPTY_TERMINAL_MODES_FIELD = encodeString(new Uint8Array([0]));

function writeBytes(target: Uint8Array, offset: number, source: Uint8Array): number {
  target.set(source, offset);
  return offset + source.length;
}

export class SSHChannel {
  private localChannelID: number = 0;
  private remoteChannelID: number = 0;
  private localWindowSize: number = 2097152;
  private remoteWindowSize: number = 0;
  private maxPacketSize: number = 32768;

  buildOpenSession(): Uint8Array {
    this.localChannelID = 0;

    const payload = new Uint8Array(1 + SESSION_FIELD.length + 12);
    let offset = 0;
    payload[offset++] = SSH_MSG_CHANNEL_OPEN;
    offset = writeBytes(payload, offset, SESSION_FIELD);
    writeUint32(payload, offset, this.localChannelID);
    offset += 4;
    writeUint32(payload, offset, this.localWindowSize);
    offset += 4;
    writeUint32(payload, offset, this.maxPacketSize);
    return payload;
  }

  handleOpenConfirmation(payload: Uint8Array): void {
    let offset = 1;
    offset += 4;
    this.remoteChannelID = readUint32(payload, offset);
    offset += 4;
    this.remoteWindowSize = readUint32(payload, offset);
    offset += 4;
    const serverMaxPacket = readUint32(payload, offset);
    this.maxPacketSize = Math.min(this.maxPacketSize, serverMaxPacket);
  }

  buildPTYRequest(cols: number, rows: number): Uint8Array {
    const payload = new Uint8Array(
      1 + 4 + PTY_REQ_FIELD.length + 1 + XTERM_256COLOR_FIELD.length + 16 + EMPTY_TERMINAL_MODES_FIELD.length
    );
    let offset = 0;
    payload[offset++] = SSH_MSG_CHANNEL_REQUEST;
    writeUint32(payload, offset, this.remoteChannelID);
    offset += 4;
    offset = writeBytes(payload, offset, PTY_REQ_FIELD);
    payload[offset++] = 0x01;
    offset = writeBytes(payload, offset, XTERM_256COLOR_FIELD);
    writeUint32(payload, offset, cols);
    offset += 4;
    writeUint32(payload, offset, rows);
    offset += 4;
    writeUint32(payload, offset, 0);
    offset += 4;
    writeUint32(payload, offset, 0);
    offset += 4;
    writeBytes(payload, offset, EMPTY_TERMINAL_MODES_FIELD);
    return payload;
  }

  buildShellRequest(): Uint8Array {
    const payload = new Uint8Array(1 + 4 + SHELL_FIELD.length + 1);
    let offset = 0;
    payload[offset++] = SSH_MSG_CHANNEL_REQUEST;
    writeUint32(payload, offset, this.remoteChannelID);
    offset += 4;
    offset = writeBytes(payload, offset, SHELL_FIELD);
    payload[offset] = 0x01;
    return payload;
  }

  buildChannelData(data: Uint8Array): Uint8Array {
    const payload = new Uint8Array(9 + data.length);
    payload[0] = SSH_MSG_CHANNEL_DATA;
    writeUint32(payload, 1, this.remoteChannelID);
    writeUint32(payload, 5, data.length);
    payload.set(data, 9);
    return payload;
  }

  handleChannelData(payload: Uint8Array): Uint8Array {
    let offset = 1;
    offset += 4;
    const dataLen = readUint32(payload, offset);
    offset += 4;
    return payload.subarray(offset, offset + dataLen);
  }

  buildWindowChange(cols: number, rows: number): Uint8Array {
    const payload = new Uint8Array(1 + 4 + WINDOW_CHANGE_FIELD.length + 1 + 16);
    let offset = 0;
    payload[offset++] = SSH_MSG_CHANNEL_REQUEST;
    writeUint32(payload, offset, this.remoteChannelID);
    offset += 4;
    offset = writeBytes(payload, offset, WINDOW_CHANGE_FIELD);
    payload[offset++] = 0x00;
    writeUint32(payload, offset, cols);
    offset += 4;
    writeUint32(payload, offset, rows);
    offset += 4;
    writeUint32(payload, offset, 0);
    offset += 4;
    writeUint32(payload, offset, 0);
    return payload;
  }

  buildWindowAdjust(bytesToAdd: number): Uint8Array {
    const payload = new Uint8Array(9);
    payload[0] = SSH_MSG_CHANNEL_WINDOW_ADJUST;
    writeUint32(payload, 1, this.remoteChannelID);
    writeUint32(payload, 5, bytesToAdd);
    return payload;
  }
}
