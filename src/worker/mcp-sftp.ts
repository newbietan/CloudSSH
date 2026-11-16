import { SFTPClient } from '../ssh/sftp';
import {
  SSH_FXP_STATUS,
  SSH_FXF_CREAT,
  SSH_FXF_EXCL,
  SSH_FXF_READ,
  SSH_FXF_WRITE,
} from '../ssh/sftp-types';
import { MCP_MAX_TEXT_BYTES, mcpHash } from '../mcp-schema';
import type { SSHSession } from './ssh-session';

/** A separate SFTP subsystem per operation; never shares the browser upload state. */
export async function withMcpSftp<T>(
  session: SSHSession,
  operation: (sftp: SFTPClient) => Promise<T>
): Promise<T> {
  const stream = await session.openSftpStream();
  const client = new SFTPClient();
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  let writes = Promise.resolve();
  client.setSendCallback((data) => {
    writes = writes
      .then(() => writer.write(data))
      .catch(() => {
        client.dispose(new Error('sftp_transport_failed'));
        stream.close();
      });
  });
  const reading = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        client.feed(value);
        client.processReceivedPackets();
      }
    } catch {
      session.close(true);
    } finally {
      client.dispose(new Error('sftp_closed'));
    }
  })();
  try {
    const ready = client.waitForVersion();
    client.setDebugCallback(() => {}, false);
    await Promise.all([writer.write(client.buildInit()), ready]);
    return await operation(client);
  } finally {
    client.dispose();
    stream.close();
    await reading;
    await writes;
    reader.releaseLock();
    writer.releaseLock();
  }
}
function ok(sftp: SFTPClient, response: Uint8Array): void {
  if (sftp.parseStatusResponse(response).code !== 0) throw new Error('sftp_operation_failed');
}
export async function mcpList(sftp: SFTPClient, path: string, limit: number) {
  const handle = sftp.parseHandleResponse(await sftp.openDir(path));
  const entries: { name: string; size?: number; permissions?: number; mtime?: number }[] = [];
  let budget = 0;
  let emptyBatches = 0;
  try {
    for (let batches = 0; batches < 32; batches++) {
      const response = await sftp.readDir(handle);
      if (response[0] === SSH_FXP_STATUS) {
        if (sftp.parseStatusResponse(response).code !== 1) throw new Error('sftp_operation_failed');
        return { entries, truncated: false };
      }
      const batch = sftp.parseNameResponse(response);
      emptyBatches = batch.length ? 0 : emptyBatches + 1;
      if (emptyBatches >= 3) throw new Error('sftp_empty_batches');
      for (const entry of batch) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        const cost = new TextEncoder().encode(JSON.stringify(entry.filename)).length + 128;
        if (entries.length >= limit || budget + cost > MCP_MAX_TEXT_BYTES)
          return { entries, truncated: true };
        budget += cost;
        entries.push({
          name: entry.filename,
          size: entry.attrs.size,
          permissions: entry.attrs.permissions,
          mtime: entry.attrs.mtime,
        });
      }
    }
    return { entries, truncated: true };
  } finally {
    await sftp.closeHandle(handle);
  }
}
export async function mcpRead(
  sftp: SFTPClient,
  path: string,
  offset = 0,
  length = MCP_MAX_TEXT_BYTES
) {
  const handle = sftp.parseHandleResponse(await sftp.openFile(path, SSH_FXF_READ));
  const bytes = new Uint8Array(length + 1);
  let size = 0;
  let eof = false;
  try {
    while (size < bytes.length) {
      const response = await sftp.readFile(
        handle,
        offset + size,
        Math.min(32 * 1024, bytes.length - size)
      );
      if (response[0] === SSH_FXP_STATUS) {
        if (sftp.parseStatusResponse(response).code !== 1) throw new Error('sftp_operation_failed');
        eof = true;
        break;
      }
      const data = sftp.parseDataResponse(response);
      if (!data.length || data.length > bytes.length - size) throw new Error('sftp_invalid_data');
      bytes.set(data, size);
      size += data.length;
    }
  } finally {
    await sftp.closeHandle(handle);
  }
  // Don't split a UTF-8 sequence at the requested byte boundary. Offset must be a character boundary.
  let end = Math.min(size, length);
  if (size > length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const selected = bytes.subarray(0, end);
  if (selected.includes(0)) throw new Error('text_files_only');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(selected);
  } catch {
    throw new Error('utf8_required');
  }
  return {
    content,
    offset,
    nextOffset: offset + end,
    eof: eof && size <= length,
    fileHash: offset === 0 && eof && size <= length ? await mcpHash(content) : null,
  };
}
export async function mcpWrite(
  sftp: SFTPClient,
  path: string,
  content: string,
  expectedHash?: string
) {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MCP_MAX_TEXT_BYTES || bytes.includes(0))
    throw new Error('text_too_large_or_binary');
  const original = await sftp.lstat(path);
  const exists = original[0] !== SSH_FXP_STATUS;
  if (!exists && sftp.parseStatusResponse(original).code !== 2)
    throw new Error('sftp_operation_failed');
  if (exists && !expectedHash) throw new Error('expected_hash_required');
  if (!exists && expectedHash) throw new Error('file_changed');
  let permissions = 0o600;
  if (exists) {
    const attrs = sftp.parseAttrsResponse(original);
    if (attrs.permissions === undefined || (attrs.permissions & 0o170000) !== 0o100000)
      throw new Error('regular_file_required');
    permissions = attrs.permissions & 0o777;
    if ((attrs.permissions & 0o7000) !== 0) throw new Error('special_permissions_unsupported');
    if (!sftp.supportsAtomicRename()) throw new Error('atomic_replace_unsupported');
    if ((await mcpRead(sftp, path)).fileHash !== expectedHash) throw new Error('file_changed');
  }
  const temp = `${path}.cloudssh-${crypto.randomUUID()}.tmp`;
  const handle = sftp.parseHandleResponse(
    await sftp.openFile(temp, SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_EXCL, 0o600)
  );
  let closed = false;
  let renamed = false;
  try {
    ok(sftp, await sftp.setPermissions(temp, permissions));
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
      ok(sftp, await sftp.writeFile(handle, offset, bytes.subarray(offset, offset + 32 * 1024)));
    }
    await sftp.closeHandle(handle);
    closed = true;
    if (exists && (await mcpRead(sftp, path)).fileHash !== expectedHash)
      throw new Error('file_changed');
    // Hash checks are best effort, not a remote compare-and-swap transaction.
    ok(sftp, exists ? await sftp.atomicRename(temp, path) : await sftp.rename(temp, path));
    renamed = true;
    return { writtenBytes: bytes.length, fileHash: await mcpHash(content) };
  } finally {
    if (!closed) {
      try {
        await sftp.closeHandle(handle);
      } catch {
        /* transport may be gone */
      }
    }
    if (!renamed) {
      try {
        await sftp.removeFile(temp);
      } catch {
        /* partial temporary file may remain */
      }
    }
  }
}
