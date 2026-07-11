import { describe, it, expect } from 'vitest';
import {
  concat,
  readUint32,
  writeUint32,
  encodeUint32,
  encodeString,
} from '../../src/ssh/utils';

describe('SSH Utils', () => {
  describe('concat', () => {
    it('should concatenate multiple Uint8Arrays', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5]);
      const c = new Uint8Array([6]);

      const result = concat(a, b, c);

      expect(result.length).toBe(6);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('should handle empty arrays', () => {
      const a = new Uint8Array([]);
      const b = new Uint8Array([1, 2]);

      const result = concat(a, b);

      expect(result.length).toBe(2);
      expect(result).toEqual(new Uint8Array([1, 2]));
    });
  });

  describe('readUint32', () => {
    it('should read big-endian uint32', () => {
      const data = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
      const result = readUint32(data, 0);

      expect(result).toBe(256);
    });

    it('should read uint32 at offset', () => {
      const data = new Uint8Array([0xFF, 0x00, 0x00, 0x01, 0x00]);
      const result = readUint32(data, 1);

      expect(result).toBe(256);
    });

    it('should read max uint32', () => {
      const data = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
      const result = readUint32(data, 0);

      expect(result).toBe(0xFFFFFFFF);
    });
  });

  describe('writeUint32', () => {
    it('should write big-endian uint32', () => {
      const data = new Uint8Array(4);
      writeUint32(data, 0, 256);

      expect(data).toEqual(new Uint8Array([0x00, 0x00, 0x01, 0x00]));
    });
  });

  describe('encodeUint32', () => {
    it('should encode uint32 as 4-byte array', () => {
      const result = encodeUint32(256);

      expect(result.length).toBe(4);
      expect(result).toEqual(new Uint8Array([0x00, 0x00, 0x01, 0x00]));
    });
  });

  describe('encodeString', () => {
    it('should encode string with length prefix', () => {
      const result = encodeString('test');

      expect(result.length).toBe(8);

      const length = readUint32(result, 0);
      expect(length).toBe(4);

      const str = new TextDecoder().decode(result.slice(4));
      expect(str).toBe('test');
    });

    it('should encode Uint8Array with length prefix', () => {
      const data = new Uint8Array([1, 2, 3]);
      const result = encodeString(data);

      expect(result.length).toBe(7);

      const length = readUint32(result, 0);
      expect(length).toBe(3);

      expect(result.slice(4)).toEqual(data);
    });

    it('should handle empty string', () => {
      const result = encodeString('');

      expect(result.length).toBe(4);
      expect(readUint32(result, 0)).toBe(0);
    });
  });
});
