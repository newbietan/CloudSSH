import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StreamingSHA256 } from '../frontend/src/sha256-stream';

describe('StreamingSHA256 — In-flight checksum', () => {
  it('matches Node crypto sha256 across varied chunk sizes', () => {
    const testCases = [
      '',
      'hello world',
      'a'.repeat(256),
      'The quick brown fox jumps over the lazy dog',
      'x'.repeat(100_000),
    ];

    for (const text of testCases) {
      const buf = Buffer.from(text);
      const expected = createHash('sha256').update(buf).digest('hex');

      const hasher = new StreamingSHA256();
      let pos = 0;
      while (pos < buf.length) {
        const take = Math.min((pos % 37) + 1, buf.length - pos);
        hasher.update(new Uint8Array(buf.subarray(pos, pos + take)));
        pos += take;
      }
      expect(hasher.digest()).toBe(expected);
    }
  });

  it('correctly hashes binary buffers with byte values 0x00 to 0xff', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const expected = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    const hasher = new StreamingSHA256();
    hasher.update(bytes);
    expect(hasher.digest()).toBe(expected);
  });
});
