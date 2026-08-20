import { describe, expect, it } from 'vitest';
import {
  deserializeServerRow,
  normalizeServerTags,
  parseStoredServerTags,
  serializeServerTags,
} from '../../src/worker/server-tags';

describe('server tags', () => {
  it('normalizes, deduplicates and limits user input', () => {
    expect(normalizeServerTags([' Production ', 'production', 'data   base', '', 42])).toEqual([
      'Production',
      'data base',
    ]);
    expect(
      normalizeServerTags(Array.from({ length: 12 }, (_, index) => `tag-${index}`))
    ).toHaveLength(10);
  });

  it('round-trips SQLite JSON and safely handles legacy values', () => {
    const stored = serializeServerTags('production， database,production');
    expect(parseStoredServerTags(stored)).toEqual(['production', 'database']);
    expect(parseStoredServerTags('legacy, tag')).toEqual(['legacy', 'tag']);
  });

  it('deserializes a database row without exposing the JSON representation', () => {
    expect(deserializeServerRow({ id: 1, tags: '["prod","apac"]' })).toEqual({
      id: 1,
      tags: ['prod', 'apac'],
    });
  });
});
