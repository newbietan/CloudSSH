import { parseStoredServerTags } from '../server-tags';
export { normalizeServerTags, serializeServerTags, parseStoredServerTags, MAX_SERVER_TAGS, MAX_SERVER_TAG_LENGTH } from '../server-tags';

export function deserializeServerRow<T extends Record<string, unknown>>(
  row: T
): Omit<T, 'tags'> & { tags: string[] } {
  return {
    ...row,
    tags: parseStoredServerTags(row.tags),
  };
}
