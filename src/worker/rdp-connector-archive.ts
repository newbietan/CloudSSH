import { RDP_CONNECTOR_BINDING_FILENAME, RDP_CONNECTOR_MAX_DOWNLOAD } from '../rdp-schema';

const localTag = 0x04034b50;
const centralTag = 0x02014b50;
const endTag = 0x06054b50;
const names = new Set(['cloudssh-rdp-connector-windows-amd64.exe', 'LICENSES.txt', 'SHA256SUMS']);
const charset = new TextDecoder();
const encoder = new TextEncoder();
const memberName = encoder.encode(RDP_CONNECTOR_BINDING_FILENAME);

type Bytes = Uint8Array<ArrayBuffer>;
interface Template {
  locals: Bytes;
  directory: Bytes;
}

/** Parse only the small, fixed ZIP32 layout made by the connector packagers. Do not inflate the EXE. */
export function inspectRdpConnectorArchive(base: ArrayBuffer): Template | null {
  if (base.byteLength < 22 || base.byteLength > RDP_CONNECTOR_MAX_DOWNLOAD) return null;
  const zip = new DataView(base),
    data = new Uint8Array(base),
    end = data.length - 22;
  const u16 = (i: number) => zip.getUint16(i, true);
  const u32 = (i: number) => zip.getUint32(i, true);
  if (
    u32(end) !== endTag ||
    u32(end + 4) !== 0 ||
    u16(end + 8) !== names.size ||
    u16(end + 10) !== names.size ||
    u16(end + 20) !== 0
  )
    return null;
  const start = u32(end + 16);
  if (!start || start + u32(end + 12) !== end) return null;
  const seen = new Set<string>();
  const spans: { start: number; end: number }[] = [];
  let cursor = start;
  while (cursor < end) {
    if (cursor + 46 > end || u32(cursor) !== centralTag || seen.size >= names.size) return null;
    const flags = u16(cursor + 8),
      method = u16(cursor + 10),
      checksum = u32(cursor + 16);
    const packed = u32(cursor + 20),
      size = u32(cursor + 24),
      length = u16(cursor + 28);
    const local = u32(cursor + 42),
      attrs = u32(cursor + 38);
    const next = cursor + 46 + length + u16(cursor + 30) + u16(cursor + 32);
    const fileType = (attrs >>> 16) & 0xf000;
    if (
      next > end ||
      local + 30 > start ||
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      (method === 0 && packed !== size) ||
      u16(cursor + 34) !== 0 ||
      !size ||
      size > 64 * 1024 * 1024 ||
      (fileType !== 0 && fileType !== 0x8000) ||
      attrs & 0x10
    )
      return null;
    const name = charset.decode(data.subarray(cursor + 46, cursor + 46 + length));
    if (
      !names.has(name) ||
      seen.has(name) ||
      !packed ||
      u32(local) !== localTag ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u16(local + 26) !== length ||
      charset.decode(data.subarray(local + 30, local + 30 + length)) !== name
    )
      return null;
    let tail = local + 30 + length + u16(local + 28) + packed;
    if (tail > start) return null;
    if (flags & 8) {
      if (tail + 12 > start) return null;
      if (u32(tail) === 0x08074b50) tail += 4;
      if (
        tail + 12 > start ||
        u32(tail) !== checksum ||
        u32(tail + 4) !== packed ||
        u32(tail + 8) !== size
      )
        return null;
      tail += 12;
    } else if (
      u32(local + 14) !== checksum ||
      u32(local + 18) !== packed ||
      u32(local + 22) !== size
    )
      return null;
    seen.add(name);
    spans.push({ start: local, end: tail });
    cursor = next;
  }
  // No duplicate, hidden, nested or trailing local ZIP members may survive extraction.
  if (seen.size !== names.size) return null;
  spans.sort((a, b) => a.start - b.start);
  if (
    spans.some((span, i) => span.start !== (spans[i - 1]?.end ?? 0)) ||
    spans.at(-1)?.end !== start
  )
    return null;
  return { locals: data.subarray(0, start), directory: data.subarray(start, end) };
}

function crc32(bytes: Bytes): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Add the private authorization as one stored ZIP member, leaving every original byte untouched. */
export function personalRdpConnectorArchive(base: Template, grant: object): Blob | null {
  const ticket = encoder.encode(JSON.stringify(grant));
  const header = new Uint8Array(30 + memberName.length);
  const record = new Uint8Array(46 + memberName.length);
  const trailer = new Uint8Array(22);
  const locals = base.locals.length + header.length + ticket.length;
  const directory = base.directory.length + record.length;
  if (ticket.length > 8192 || locals + directory + trailer.length > RDP_CONNECTOR_MAX_DOWNLOAD)
    return null;
  const crc = crc32(ticket);
  const l = new DataView(header.buffer),
    r = new DataView(record.buffer),
    e = new DataView(trailer.buffer);
  l.setUint32(0, localTag, true);
  l.setUint16(4, 20, true);
  l.setUint16(12, 0x21, true);
  l.setUint32(14, crc, true);
  l.setUint32(18, ticket.length, true);
  l.setUint32(22, ticket.length, true);
  l.setUint16(26, memberName.length, true);
  header.set(memberName, 30);
  r.setUint32(0, centralTag, true);
  r.setUint16(4, 20, true);
  r.setUint16(6, 20, true);
  r.setUint16(14, 0x21, true);
  r.setUint32(16, crc, true);
  r.setUint32(20, ticket.length, true);
  r.setUint32(24, ticket.length, true);
  r.setUint16(28, memberName.length, true);
  r.setUint32(42, base.locals.length, true);
  record.set(memberName, 46);
  e.setUint32(0, endTag, true);
  e.setUint16(8, names.size + 1, true);
  e.setUint16(10, names.size + 1, true);
  e.setUint32(12, directory, true);
  e.setUint32(16, locals, true);
  return new Blob([base.locals, header, ticket, base.directory, record, trailer], {
    type: 'application/zip',
  });
}
