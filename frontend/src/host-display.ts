function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function parseIPv6Side(side: string): number[] | null {
  if (!side) return [];

  const parts = side.split(':');
  if (parts.some((part) => !part)) return null;

  const groups: number[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.includes('.')) {
      if (index !== parts.length - 1) return null;
      const octets = parseIPv4(part);
      if (!octets) return null;
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIPv6(address: string): number[] | null {
  if (!address.includes(':')) return null;

  const compressedParts = address.split('::');
  if (compressedParts.length > 2) return null;

  const left = parseIPv6Side(compressedParts[0]);
  const right = parseIPv6Side(compressedParts[1] ?? '');
  if (!left || !right) return null;

  if (compressedParts.length === 1) {
    return left.length === 8 ? left : null;
  }

  const omittedGroups = 8 - left.length - right.length;
  if (omittedGroups < 1) return null;
  return [...left, ...Array<number>(omittedGroups).fill(0), ...right];
}

/**
 * 为界面生成 IP 地址的隐私化展示文本。返回 null 表示该主机不是有效 IP 字面量。
 * 仅改变视觉展示；连接和复制仍使用原始 host。
 */
export function maskIPAddress(host: string): string | null {
  const ipv4 = parseIPv4(host);
  if (ipv4) return `${ipv4[0]}.${ipv4[1]}.*.*`;

  const unwrapped = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  const zoneIndex = unwrapped.indexOf('%');
  const address = zoneIndex === -1 ? unwrapped : unwrapped.slice(0, zoneIndex);
  const ipv6 = parseIPv6(address);
  if (!ipv6) return null;

  return `${ipv6[0].toString(16)}:${ipv6[1].toString(16)}:…`;
}
