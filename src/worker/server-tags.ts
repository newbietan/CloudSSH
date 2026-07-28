export const MAX_SERVER_TAGS = 10;
export const MAX_SERVER_TAG_LENGTH = 24;

export function normalizeServerTags(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，]/)
      : [];
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const tag = candidate.trim().replace(/\s+/g, ' ').slice(0, MAX_SERVER_TAG_LENGTH);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_SERVER_TAGS) break;
  }

  return tags;
}

export function parseStoredServerTags(value: unknown): string[] {
  if (typeof value !== 'string') return normalizeServerTags(value);
  try {
    return normalizeServerTags(JSON.parse(value));
  } catch {
    return normalizeServerTags(value);
  }
}

export function serializeServerTags(value: unknown): string {
  return JSON.stringify(normalizeServerTags(value));
}

export function deserializeServerRow<T extends Record<string, unknown>>(
  row: T,
): Omit<T, 'tags'> & { tags: string[] } {
  return {
    ...row,
    tags: parseStoredServerTags(row.tags),
  };
}
