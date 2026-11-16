import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SFTP_PACKET_BYTES, MAX_SFTP_RECEIVE_BYTES, SFTPClient } from '../../src/ssh/sftp';
import { SSH_FILEXFER_ATTR_PERMISSIONS, SSH_FXP_ATTRS, SSH_FXP_DATA, SSH_FXP_HANDLE,
  SSH_FXP_NAME, SSH_FXP_OPEN, SSH_FXP_STATUS, SSH_FXP_VERSION } from '../../src/ssh/sftp-types';
import { concat, encodeString, encodeUint32, writeUint32 } from '../../src/ssh/utils';

function body(type: number, id: number, ...parts: Uint8Array[]) {
  return concat(new Uint8Array([type]), encodeUint32(id), ...parts);
}
function frame(response: Uint8Array) { return concat(encodeUint32(response.length), response); }
function entry(name: string, attrs = encodeUint32(0)) {
  return concat(encodeString(name), encodeString(''), attrs);
}

describe('SFTP v3 bounded decoding', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([0, 1, 4, MAX_SFTP_PACKET_BYTES + 1, 0xffffffff])(
    'rejects impossible packet length %s from the header alone', (length) => {
      const client = new SFTPClient();
      client.feed(encodeUint32(length));
      expect(() => client.processReceivedPackets()).toThrow('packet length');
      expect((client as any).recvBuffer.length).toBe(0);
    }
  );

  it('bounds individual NAME fields independently of packet size', () => {
    const client = new SFTPClient();
    expect(() => client.parseNameResponse(body(SSH_FXP_NAME, 1, encodeUint32(1),
      entry('x'.repeat(16 * 1024 + 1))))).toThrow('string field limit');
  });

  it('bounds aggregate receive bytes before copying', () => {
    const client = new SFTPClient();
    client.feed(new Uint8Array(MAX_SFTP_RECEIVE_BYTES));
    expect(() => client.feed(new Uint8Array(1))).toThrow('buffer limit');
    expect((client as any).recvBuffer.length).toBe(0);
  });

  it('fragmented 128KiB DATA still resolves normally', async () => {
    const client = new SFTPClient();
    client.setSendCallback(vi.fn());
    const pending = client.readFile(new Uint8Array([1]), 0, 128 * 1024);
    const content = new Uint8Array(128 * 1024).fill(65);
    const wire = frame(body(SSH_FXP_DATA, 1, encodeString(content)));
    for (let offset = 0; offset < wire.length; offset += 16 * 1024) {
      client.feed(wire.subarray(offset, offset + 16 * 1024));
      client.processReceivedPackets();
    }
    expect(client.parseDataResponse(await pending)).toEqual(content);
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });

  it('malformed response rejects ALL pending requests and releases timers/buffers', async () => {
    const client = new SFTPClient();
    client.setSendCallback(vi.fn());
    const first = client.openDir('/').catch(error => error);
    const second = client.stat('/').catch(error => error);
    client.feed(frame(body(SSH_FXP_HANDLE, 1, encodeUint32(100))));
    expect(() => client.processReceivedPackets()).toThrow('truncated');
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect((client as any).pendingRequests.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.stat('/')).rejects.toThrow('truncated');
  });

  it('rejects a structurally valid response of the wrong request type', async () => {
    const client = new SFTPClient();
    client.setSendCallback(vi.fn());
    const pending = client.stat('/').catch(error => error);
    client.feed(frame(body(SSH_FXP_HANDLE, 1, encodeString('handle'))));
    expect(() => client.processReceivedPackets()).toThrow('does not match');
    expect(await pending).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0o600, 0])('encodes OPEN permissions %s at creation without changing default requests', async permissions => {
    const client = new SFTPClient();
    const send = vi.fn();
    client.setSendCallback(send);
    const path = '/tmp/private-file';
    const flags = 2 | 8 | 32;
    const pending = client.openFile(path, flags, permissions);
    const attrs = permissions === undefined
      ? encodeUint32(0)
      : concat(encodeUint32(SSH_FILEXFER_ATTR_PERMISSIONS), encodeUint32(permissions));
    expect(send).toHaveBeenCalledWith(frame(body(SSH_FXP_OPEN, 1,
      encodeString(path), encodeUint32(flags), attrs)));
    client.feed(frame(body(SSH_FXP_HANDLE, 1, encodeString('handle'))));
    client.processReceivedPackets();
    expect(client.parseHandleResponse(await pending)).toEqual(new TextEncoder().encode('handle'));
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });

  it('a synchronous send failure leaves no request timer behind', async () => {
    const client = new SFTPClient();
    client.setSendCallback(() => { throw new Error('send failed'); });
    await expect(client.stat('/')).rejects.toThrow('send failed');
    expect((client as any).pendingRequests.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([2, 0xffffffff])('rejects NAME count %s before looping over absent fields', count => {
    const client = new SFTPClient();
    expect(() => client.parseNameResponse(body(SSH_FXP_NAME, 1, encodeUint32(count))))
      .toThrow('entry count');
  });

  it('validates every NAME string and attribute field, including extended pairs', () => {
    const client = new SFTPClient();
    const extended = concat(encodeUint32(0x80000004), encodeUint32(0o100644),
      encodeUint32(1), encodeString('vendor'), encodeString('value'));
    const valid = body(SSH_FXP_NAME, 1, encodeUint32(2), entry('first', extended), entry('second'));
    expect(client.parseNameResponse(valid).map(item => item.filename)).toEqual(['first', 'second']);
    expect(client.parseNameResponse(valid)[0].attrs.permissions).toBe(0o100644);
    for (let length = 0; length < valid.length; length++) {
      expect(() => client.parseNameResponse(valid.subarray(0, length))).toThrow();
    }
    const badString = body(SSH_FXP_NAME, 1, encodeUint32(1), entry('first'));
    writeUint32(badString, 9, 0xffffffff);
    expect(() => client.parseNameResponse(badString)).toThrow('string field limit');
  });

  it('accepts all standard attributes and rejects missing/unknown/unsafe values', () => {
    const client = new SFTPClient();
    const attrs = body(SSH_FXP_ATTRS, 1, encodeUint32(15), encodeUint32(0), encodeUint32(128),
      encodeUint32(10), encodeUint32(11), encodeUint32(0o100644), encodeUint32(12), encodeUint32(13));
    expect(client.parseAttrsResponse(attrs)).toEqual({ size: 128, uid: 10, gid: 11,
      permissions: 0o100644, atime: 12, mtime: 13 });
    for (let length = 0; length < attrs.length; length++) {
      expect(() => client.parseAttrsResponse(attrs.subarray(0, length))).toThrow();
    }
    expect(() => client.parseAttrsResponse(body(SSH_FXP_ATTRS, 1, encodeUint32(16))))
      .toThrow('flags');
    expect(() => client.parseAttrsResponse(body(SSH_FXP_ATTRS, 1, encodeUint32(1),
      encodeUint32(0xffffffff), encodeUint32(0xffffffff)))).toThrow('out of range');
    expect(() => client.parseAttributes(encodeUint32(0x80000000), 0)).toThrow('truncated');
    expect(() => client.parseAttributes(concat(encodeUint32(0x80000000), encodeUint32(0xffffffff)), 0))
      .toThrow('attribute count');
  });

  it('STATUS requires message/language fields; HANDLE/DATA require exact lengths', () => {
    const client = new SFTPClient();
    const status = body(SSH_FXP_STATUS, 1, encodeUint32(0), encodeString('OK'), encodeString(''));
    expect(client.parseStatusResponse(status)).toEqual({ code: 0, message: 'OK' });
    for (let length = 0; length < status.length; length++) {
      expect(() => client.parseStatusResponse(status.subarray(0, length))).toThrow();
    }
    expect(() => client.parseHandleResponse(body(SSH_FXP_HANDLE, 1, encodeString('')))).toThrow('handle');
    expect(() => client.parseHandleResponse(body(SSH_FXP_HANDLE, 1, encodeString(new Uint8Array(257)))))
      .toThrow('handle');
    expect(() => client.parseDataResponse(body(SSH_FXP_DATA, 1, encodeUint32(100))))
      .toThrow('truncated');
    expect(() => client.parseDataResponse(body(SSH_FXP_DATA, 1, encodeString('a'), new Uint8Array([0]))))
      .toThrow('trailing');
  });

  it('parses VERSION extension pairs and rejects unsupported/truncated versions', async () => {
    const client = new SFTPClient();
    const pending = client.waitForVersion();
    client.feed(frame(body(SSH_FXP_VERSION, 3, encodeString('extension'), encodeString('data'))));
    client.processReceivedPackets();
    expect(await pending).toBe(3);
    client.dispose();
    for (const response of [body(SSH_FXP_VERSION, 4), body(SSH_FXP_VERSION, 3, encodeString('name'))]) {
      const bad = new SFTPClient();
      const version = bad.waitForVersion().catch(error => error);
      bad.feed(frame(response));
      expect(() => bad.processReceivedPackets()).toThrow();
      expect(await version).toBeInstanceOf(Error);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
