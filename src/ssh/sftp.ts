import {
  getStatusMessage,
  type SFTPFileAttributes,
  type SFTPFileEntry,
  type SFTPPendingRequest,
  SSH_FILEXFER_ATTR_ACMODTIME,
  SSH_FILEXFER_ATTR_EXTENDED,
  SSH_FILEXFER_ATTR_PERMISSIONS,
  SSH_FILEXFER_ATTR_SIZE,
  SSH_FILEXFER_ATTR_UIDGID,
  SSH_FX_EOF,
  SSH_FXP_CLOSE,
  SSH_FXP_ATTRS,
  SSH_FXP_DATA,
  SSH_FXP_HANDLE,
  SSH_FXP_INIT,
  SSH_FXP_MKDIR,
  SSH_FXP_NAME,
  SSH_FXP_OPEN,
  SSH_FXP_OPENDIR,
  SSH_FXP_READ,
  SSH_FXP_READDIR,
  SSH_FXP_REALPATH,
  SSH_FXP_REMOVE,
  SSH_FXP_RENAME,
  SSH_FXP_RMDIR,
  SSH_FXP_STAT,
  SSH_FXP_STATUS,
  SSH_FXP_VERSION,
  SSH_FXP_WRITE,
} from './sftp-types';
import { encodeString, readUint32, writeUint32 } from './utils';
import { SFTPReader } from './sftp-reader';

const SFTP_VERSION = 3;
const REQUEST_TIMEOUT_MS = 60000; // 60 seconds for SFTP operations
// Allows existing 128KiB reads and large NAME batches, while bounding partial packets.
export const MAX_SFTP_PACKET_BYTES = 1024 * 1024;
export const MAX_SFTP_RECEIVE_BYTES = 2 * 1024 * 1024;
const MAX_NAME_ENTRIES = 10_000;
const MAX_EXTENDED_ATTRIBUTES = 1024;
export const MAX_SFTP_LIST_ENTRIES = 10_000;
export const MAX_SFTP_LIST_MEMORY_BYTES = 8 * 1024 * 1024;
const MAX_SFTP_NAME_FIELD_BYTES = 16 * 1024;

// Conservative accounting for UTF-16 strings plus entry/attribute objects.
export function estimateSFTPEntryBytes(entry: SFTPFileEntry): number {
  return 256 + 2 * (entry.filename.length + entry.longname.length);
}
const MAX_LIST_REQUESTS = 1024;
const MAX_EMPTY_LIST_BATCHES = 3;

export interface SFTPRequestOptions { deadline?: number; }
export interface SFTPListingOptions extends SFTPRequestOptions {
  beforeRequest?: () => void;
  maxRequests?: number;
}

export class SFTPClient {
  private readonly textDecoder = new TextDecoder();
  private requestId: number = 0;
  private pendingRequests: Map<number, SFTPPendingRequest> = new Map();
  private recvBuffer: Uint8Array = new Uint8Array(0);
  private recvOffset: number = 0;
  private version: number = 0;
  private atomicRenameSupported = false;
  private sendData: ((data: Uint8Array) => void) | null = null;
  private debugFn: ((message: string) => void) | null = null;
  private debugEnabled: boolean = false;
  private disposedError: Error | null = null;

  setSendCallback(fn: (data: Uint8Array) => void): void {
    this.sendData = fn;
  }

  setDebugCallback(fn: (message: string) => void, enabled: boolean = true): void {
    this.debugFn = fn;
    this.debugEnabled = enabled;
  }

  private debug(message: string | (() => string)): void {
    if (!this.debugEnabled || !this.debugFn) return;
    this.debugFn(typeof message === 'function' ? message() : message);
  }

  dispose(error = new Error('SFTP session closed')): void {
    this.disposedError ??= error;
    for (const [, req] of this.pendingRequests) {
      if (req.timeout) clearTimeout(req.timeout);
      req.reject(this.disposedError);
    }
    this.pendingRequests.clear();
    this.recvBuffer = new Uint8Array(0);
    this.recvOffset = 0;
  }

  // Build SFTP init packet
  buildInit(): Uint8Array {
    const packet = new Uint8Array(9); // 4 (length) + 1 (type) + 4 (version)
    writeUint32(packet, 0, 1 + 4); // length = type(1) + version(4)
    packet[4] = SSH_FXP_INIT;
    writeUint32(packet, 5, SFTP_VERSION);
    return packet;
  }

  // Feed incoming channel data into the SFTP receive buffer
  feed(data: Uint8Array): void {
    if (this.disposedError) throw this.disposedError;
    const pending = this.recvBuffer.length - this.recvOffset;
    if (data.length > MAX_SFTP_RECEIVE_BYTES - pending) {
      const error = new Error('SFTP receive buffer limit exceeded');
      this.dispose(error);
      throw error;
    }
    if (this.recvOffset >= this.recvBuffer.length) {
      this.recvBuffer = data;
      this.recvOffset = 0;
      return;
    }

    const remaining = this.recvBuffer.length - this.recvOffset;
    const merged = new Uint8Array(remaining + data.length);
    merged.set(this.recvBuffer.subarray(this.recvOffset));
    merged.set(data, remaining);
    this.recvBuffer = merged;
    this.recvOffset = 0;
  }

  // Try to extract and dispatch complete SFTP packets from the buffer
  processReceivedPackets(): void {
    if (this.disposedError) throw this.disposedError;
    try {
      this.processBufferedPackets();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Invalid SFTP response');
      this.dispose(failure);
      throw failure;
    }
  }

  private processBufferedPackets(): void {
    this.debug(() => `[SFTP] processReceived: bufLen=${this.recvBuffer.length - this.recvOffset}`);
    while (this.recvBuffer.length - this.recvOffset >= 4) {
      const packetLen = readUint32(this.recvBuffer, this.recvOffset);
      if (packetLen < 5 || packetLen > MAX_SFTP_PACKET_BYTES) {
        throw new Error('Invalid SFTP packet length');
      }
      const totalLen = 4 + packetLen;

      this.debug(
        () =>
          `[SFTP] Found packet: len=${packetLen}, total=${totalLen}, buf=${this.recvBuffer.length - this.recvOffset}`
      );

      if (this.recvBuffer.length - this.recvOffset < totalLen) {
        this.debug('[SFTP] Incomplete, waiting');
        break; // incomplete packet
      }

      const packetData = this.recvBuffer.subarray(this.recvOffset + 4, this.recvOffset + totalLen);
      this.recvOffset += totalLen;

      this.debug(() => `[SFTP] Processing: type=${packetData[0]}, len=${packetData.length}`);
      this.handleSFTPPacket(packetData);
    }

    if (this.recvOffset >= this.recvBuffer.length) {
      this.recvBuffer = new Uint8Array(0);
      this.recvOffset = 0;
    } else if (this.recvOffset > 64 * 1024 && this.recvOffset * 2 > this.recvBuffer.length) {
      this.recvBuffer = this.recvBuffer.slice(this.recvOffset);
      this.recvOffset = 0;
    }
  }

  private handleSFTPPacket(data: Uint8Array): void {
    const type = data[0];
    this.debug(() => `[SFTP] handlePacket: type=${type}, len=${data.length}`);

    if (type === SSH_FXP_VERSION) {
      const reader = new SFTPReader(data, 1);
      this.version = reader.uint32();
      if (this.version !== SFTP_VERSION) throw new Error('Unsupported SFTP version');
      while (reader.remaining > 0) {
        const name = this.textDecoder.decode(reader.stringBytes());
        const value = this.textDecoder.decode(reader.stringBytes());
        if (name === 'posix-rename@openssh.com' && value === '1') this.atomicRenameSupported = true;
      }
      this.debug(() => `[SFTP] VERSION: ${this.version}`);

      // Resolve the init request
      const req = this.pendingRequests.get(0);
      if (req) {
        this.debug('[SFTP] Resolving init (id=0)');
        if (req.timeout) clearTimeout(req.timeout);
        this.pendingRequests.delete(0);
        req.resolve(data);
      } else {
        this.debug('[SFTP] No pending request for id=0');
      }
      return;
    }

    // Validate complete response structure before resolving any request.
    switch (type) {
      case SSH_FXP_STATUS: this.parseStatusResponse(data); break;
      case SSH_FXP_HANDLE: this.parseHandleResponse(data); break;
      case SSH_FXP_DATA: this.parseDataResponse(data); break;
      case SSH_FXP_NAME: this.readNameResponse(data, false); break;
      case SSH_FXP_ATTRS: this.parseAttrsResponse(data); break;
      default: throw new Error('Unexpected SFTP response type');
    }
    const reqId = readUint32(data, 1);
    const req = this.pendingRequests.get(reqId);
    if (!req) {
      return; // stale or unsolicited
    }

    const expected = req.type === SSH_FXP_OPEN || req.type === SSH_FXP_OPENDIR
      ? SSH_FXP_HANDLE : req.type === SSH_FXP_READ ? SSH_FXP_DATA
      : req.type === SSH_FXP_READDIR || req.type === SSH_FXP_REALPATH ? SSH_FXP_NAME
      : req.type === SSH_FXP_STAT || req.type === 7 ? SSH_FXP_ATTRS : SSH_FXP_STATUS;
    if (type !== SSH_FXP_STATUS && type !== expected) {
      throw new Error('SFTP response does not match request');
    }
    if (req.timeout) clearTimeout(req.timeout);
    this.pendingRequests.delete(reqId);

    req.resolve(data);
  }

  private nextRequestId(): number {
    return ++this.requestId;
  }

  private sendRequest(
    requestId: number, type: number, payload: Uint8Array, options: SFTPRequestOptions = {}
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (this.disposedError) { reject(this.disposedError); return; }
      const remaining = options.deadline === undefined ? REQUEST_TIMEOUT_MS : options.deadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        reject(new Error('SFTP operation deadline exceeded'));
        return;
      }
      if (!this.sendData) {
        reject(new Error('SFTP send callback not set'));
        return;
      }

      const packetLen = 1 + 4 + payload.length; // type + requestId + payload
      const packet = new Uint8Array(4 + packetLen);
      writeUint32(packet, 0, packetLen);
      packet[4] = type;
      writeUint32(packet, 5, requestId);
      packet.set(payload, 9);

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('SFTP request timeout'));
      }, Math.min(REQUEST_TIMEOUT_MS, remaining));

      this.pendingRequests.set(requestId, { requestId, type, resolve, reject, timeout });
      try { this.sendData(packet); }
      catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  // Wait for init/version exchange
  async waitForVersion(): Promise<number> {
    if (this.disposedError) throw this.disposedError;
    this.debug(() => `[SFTP] waitForVersion: pending=${this.pendingRequests.size}`);

    const data = await new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.debug(() => `[SFTP] waitForVersion TIMEOUT ${REQUEST_TIMEOUT_MS}ms`);
        this.pendingRequests.delete(0);
        reject(new Error('SFTP version timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(0, { requestId: 0, type: SSH_FXP_INIT, resolve, reject, timeout });
      this.debug('[SFTP] waitForVersion: registered');
    });

    this.version = readUint32(data, 1);
    this.debug(() => `[SFTP] waitForVersion: version=${this.version}`);
    return this.version;
  }

  // Parse SFTP_ATTRS from buffer
  parseAttributes(
    data: Uint8Array,
    offset: number
  ): { attrs: SFTPFileAttributes; consumed: number } {
    const reader = new SFTPReader(data, offset);
    const attrs = this.readAttributes(reader);
    return { attrs, consumed: reader.position - offset };
  }

  private readAttributes(reader: SFTPReader): SFTPFileAttributes {
    const attrs: SFTPFileAttributes = {};
    const flags = reader.uint32();
    if ((flags & ~0x8000000f) !== 0) throw new Error('Unsupported SFTP attribute flags');
    if (flags & SSH_FILEXFER_ATTR_SIZE) {
      attrs.size = reader.uint32() * 0x100000000 + reader.uint32();
      if (!Number.isSafeInteger(attrs.size)) throw new Error('SFTP file size is out of range');
    }
    if (flags & SSH_FILEXFER_ATTR_UIDGID) {
      attrs.uid = reader.uint32();
      attrs.gid = reader.uint32();
    }
    if (flags & SSH_FILEXFER_ATTR_PERMISSIONS) attrs.permissions = reader.uint32();
    if (flags & SSH_FILEXFER_ATTR_ACMODTIME) {
      attrs.atime = reader.uint32();
      attrs.mtime = reader.uint32();
    }
    if (flags & SSH_FILEXFER_ATTR_EXTENDED) {
      const count = reader.uint32();
      if (count > MAX_EXTENDED_ATTRIBUTES || count > Math.floor(reader.remaining / 8)) {
        throw new Error('Invalid SFTP extended attribute count');
      }
      for (let i = 0; i < count; i++) {
        reader.stringBytes();
        reader.stringBytes();
      }
    }
    return attrs;
  }

  // SSH_FXP_OPENDIR
  async openDir(path: string, options?: SFTPRequestOptions): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const pathBytes = encodeString(path);
    const payload = new Uint8Array(pathBytes.length);
    payload.set(pathBytes);
    return this.sendRequest(reqId, SSH_FXP_OPENDIR, payload, options);
  }

  // SSH_FXP_READDIR
  async readDir(handle: Uint8Array, options?: SFTPRequestOptions): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const payload = new Uint8Array(4 + handle.length);
    writeUint32(payload, 0, handle.length);
    payload.set(handle, 4);
    return this.sendRequest(reqId, SSH_FXP_READDIR, payload, options);
  }

  // SSH_FXP_CLOSE
  async closeHandle(handle: Uint8Array, options?: SFTPRequestOptions): Promise<void> {
    const reqId = this.nextRequestId();
    const payload = new Uint8Array(4 + handle.length);
    writeUint32(payload, 0, handle.length);
    payload.set(handle, 4);
    const response = await this.sendRequest(reqId, SSH_FXP_CLOSE, payload, options);
    const status = this.parseStatusResponse(response);
    if (status.code !== 0) throw new Error(status.message);
  }

  // SSH_FXP_STAT
  async stat(path: string): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const pathBytes = encodeString(path);
    const payload = new Uint8Array(pathBytes.length);
    payload.set(pathBytes);
    return this.sendRequest(reqId, SSH_FXP_STAT, payload);
  }

  async lstat(path: string): Promise<Uint8Array> {
    return this.sendRequest(this.nextRequestId(), 7, encodeString(path));
  }

  async setPermissions(path: string, permissions: number): Promise<Uint8Array> {
    const pathBytes = encodeString(path);
    const payload = new Uint8Array(pathBytes.length + 8);
    payload.set(pathBytes);
    writeUint32(payload, pathBytes.length, SSH_FILEXFER_ATTR_PERMISSIONS);
    writeUint32(payload, pathBytes.length + 4, permissions);
    return this.sendRequest(this.nextRequestId(), 9, payload);
  }

  // SSH_FXP_OPEN
  async openFile(path: string, flags: number, permissions?: number): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const pathBytes = encodeString(path);
    // pflags(4) + attribute flags(4) + optional creation permissions(4).
    const payload = new Uint8Array(pathBytes.length + 8 + (permissions === undefined ? 0 : 4));
    let offset = 0;
    payload.set(pathBytes, offset);
    offset += pathBytes.length;
    writeUint32(payload, offset, flags);
    offset += 4;
    writeUint32(payload, offset, permissions === undefined ? 0 : SSH_FILEXFER_ATTR_PERMISSIONS);
    if (permissions !== undefined) writeUint32(payload, offset + 4, permissions);
    return this.sendRequest(reqId, SSH_FXP_OPEN, payload);
  }

  // SSH_FXP_READ
  async readFile(handle: Uint8Array, offset: number, length: number): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const payload = new Uint8Array(4 + handle.length + 8 + 4);
    let pos = 0;
    writeUint32(payload, pos, handle.length);
    pos += 4;
    payload.set(handle, pos);
    pos += handle.length;
    // offset as uint64 (high=0, low=offset)
    writeUint32(payload, pos, 0);
    pos += 4;
    writeUint32(payload, pos, offset);
    pos += 4;
    writeUint32(payload, pos, length);
    return this.sendRequest(reqId, SSH_FXP_READ, payload);
  }

  // SSH_FXP_WRITE
  async writeFile(handle: Uint8Array, offset: number, data: Uint8Array): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const payload = new Uint8Array(4 + handle.length + 8 + 4 + data.length);
    let pos = 0;
    writeUint32(payload, pos, handle.length);
    pos += 4;
    payload.set(handle, pos);
    pos += handle.length;
    writeUint32(payload, pos, 0);
    pos += 4;
    writeUint32(payload, pos, offset);
    pos += 4;
    writeUint32(payload, pos, data.length);
    pos += 4;
    payload.set(data, pos);
    return this.sendRequest(reqId, SSH_FXP_WRITE, payload);
  }

  // SSH_FXP_REMOVE
  async removeFile(path: string, options?: SFTPRequestOptions): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const pathBytes = encodeString(path);
    const payload = new Uint8Array(pathBytes.length);
    payload.set(pathBytes);
    return this.sendRequest(reqId, SSH_FXP_REMOVE, payload, options);
  }

  // SSH_FXP_MKDIR
  async mkdir(path: string, permissions: number = 0o755): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const pathBytes = encodeString(path);
    const payload = new Uint8Array(pathBytes.length + 4 + 4);
    let offset = 0;
    payload.set(pathBytes, offset);
    offset += pathBytes.length;
    writeUint32(payload, offset, SSH_FILEXFER_ATTR_PERMISSIONS);
    offset += 4;
    writeUint32(payload, offset, permissions);
    return this.sendRequest(reqId, SSH_FXP_MKDIR, payload);
  }

  // SSH_FXP_RMDIR
  async rmdir(path: string, options?: SFTPRequestOptions): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const pathBytes = encodeString(path);
    const payload = new Uint8Array(pathBytes.length);
    payload.set(pathBytes);
    return this.sendRequest(reqId, SSH_FXP_RMDIR, payload, options);
  }

  // SSH_FXP_RENAME
  async rename(oldPath: string, newPath: string): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const oldBytes = encodeString(oldPath);
    const newBytes = encodeString(newPath);
    const payload = new Uint8Array(oldBytes.length + newBytes.length);
    payload.set(oldBytes);
    payload.set(newBytes, oldBytes.length);
    return this.sendRequest(reqId, SSH_FXP_RENAME, payload);
  }

  supportsAtomicRename(): boolean { return this.atomicRenameSupported; }

  async atomicRename(oldPath: string, newPath: string): Promise<Uint8Array> {
    if (!this.atomicRenameSupported) throw new Error('atomic_replace_unsupported');
    const fields = [encodeString('posix-rename@openssh.com'), encodeString(oldPath), encodeString(newPath)];
    const payload = new Uint8Array(fields.reduce((size, field) => size + field.length, 0));
    let offset = 0;
    for (const field of fields) { payload.set(field, offset); offset += field.length; }
    return this.sendRequest(this.nextRequestId(), 200, payload);
  }

  // SSH_FXP_REALPATH
  async realpath(path: string): Promise<Uint8Array> {
    const reqId = this.nextRequestId();
    const pathBytes = encodeString(path);
    const payload = new Uint8Array(pathBytes.length);
    payload.set(pathBytes);
    return this.sendRequest(reqId, SSH_FXP_REALPATH, payload);
  }

  // Parse SSH_FXP_STATUS response
  parseStatusResponse(data: Uint8Array): { code: number; message: string } {
    const reader = this.responseReader(data, SSH_FXP_STATUS);
    const code = reader.uint32();
    const message = this.textDecoder.decode(reader.stringBytes());
    reader.stringBytes(); // language tag (mandatory in SFTP v3)
    reader.end();
    return { code, message: message || getStatusMessage(code) };
  }

  // Parse SSH_FXP_HANDLE response
  parseHandleResponse(data: Uint8Array): Uint8Array {
    const reader = this.responseReader(data, SSH_FXP_HANDLE);
    const handle = reader.stringBytes();
    if (handle.length === 0 || handle.length > 256) throw new Error('Invalid SFTP handle');
    reader.end();
    return handle;
  }

  // Parse SSH_FXP_DATA response
  parseDataResponse(data: Uint8Array): Uint8Array {
    const reader = this.responseReader(data, SSH_FXP_DATA);
    const bytes = reader.stringBytes();
    reader.end();
    return bytes;
  }

  // Parse SSH_FXP_NAME response for directory listing
  parseNameResponse(data: Uint8Array): SFTPFileEntry[] {
    return this.readNameResponse(data, true);
  }

  private readNameResponse(data: Uint8Array, collect: boolean): SFTPFileEntry[] {
    const reader = this.responseReader(data, SSH_FXP_NAME);
    const count = reader.uint32();
    // Each entry needs at least two string lengths and attribute flags (12 bytes).
    if (count > MAX_NAME_ENTRIES || count > Math.floor(reader.remaining / 12)) {
      throw new Error('Invalid SFTP directory entry count');
    }
    const entries: SFTPFileEntry[] = [];
    for (let i = 0; i < count; i++) {
      const filename = reader.stringBytes(MAX_SFTP_NAME_FIELD_BYTES);
      const longname = reader.stringBytes(MAX_SFTP_NAME_FIELD_BYTES);
      const attrs = this.readAttributes(reader);
      if (collect) entries.push({
        filename: this.textDecoder.decode(filename),
        longname: this.textDecoder.decode(longname), attrs,
      });
    }
    reader.end();
    return entries;
  }

  private responseReader(data: Uint8Array, type: number): SFTPReader {
    if (data[0] !== type) throw new Error('Unexpected SFTP response type');
    return new SFTPReader(data, 5);
  }

  // Parse SSH_FXP_ATTRS response
  parseAttrsResponse(data: Uint8Array): SFTPFileAttributes {
    const reader = this.responseReader(data, SSH_FXP_ATTRS);
    const attrs = this.readAttributes(reader);
    reader.end();
    return attrs;
  }

  // Parse all entries from a full directory listing (may need multiple READDIR calls)
  async listAllEntries(
    handle: Uint8Array,
    limit = MAX_SFTP_LIST_ENTRIES,
    options: SFTPListingOptions = {}
  ): Promise<{ entries: SFTPFileEntry[]; isTruncated: boolean }> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SFTP_LIST_ENTRIES) {
      throw new Error('Invalid SFTP directory entry limit');
    }
    const deadline = options.deadline ?? Date.now() + REQUEST_TIMEOUT_MS;
    const maxRequests = Math.min(options.maxRequests ?? MAX_LIST_REQUESTS, MAX_LIST_REQUESTS);
    const allEntries: SFTPFileEntry[] = [];
    let emptyBatches = 0;
    let entryBytes = 0;
    for (let requests = 0; ; requests++) {
      if (Date.now() >= deadline) throw new Error('SFTP directory listing deadline exceeded');
      if (requests >= maxRequests) throw new Error('SFTP directory listing request limit exceeded');
      options.beforeRequest?.();
      const response = await this.readDir(handle, { deadline });
      if (Date.now() >= deadline) throw new Error('SFTP directory listing deadline exceeded');
      if (response[0] === SSH_FXP_STATUS) {
        const status = this.parseStatusResponse(response);
        if (status.code === SSH_FX_EOF) return { entries: allEntries, isTruncated: false };
        throw new Error(status.message);
      }
      if (response[0] !== SSH_FXP_NAME) throw new Error('Unexpected SFTP directory response');
      const entries = this.parseNameResponse(response);
      emptyBatches = entries.length === 0 ? emptyBatches + 1 : 0;
      if (emptyBatches >= MAX_EMPTY_LIST_BATCHES) throw new Error('SFTP directory listing made no progress');
      for (const entry of entries) {
        const bytes = estimateSFTPEntryBytes(entry);
        if (allEntries.length >= limit || bytes > MAX_SFTP_LIST_MEMORY_BYTES - entryBytes) {
          return { entries: allEntries, isTruncated: true };
        }
        allEntries.push(entry);
        entryBytes += bytes;
      }
      // At exactly the limit, read once more to distinguish a complete directory
      // ending in EOF from a truncated one; never collect beyond the cap.
    }
  }
}
