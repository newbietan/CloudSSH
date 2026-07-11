import { describe, it, expect } from 'vitest';
import { normalizeTerminalSize } from '../src/types';

describe('Types', () => {
  describe('normalizeTerminalSize', () => {
    it('should return valid terminal size', () => {
      const result = normalizeTerminalSize(80, 24);

      expect(result).not.toBeNull();
      expect(result!.cols).toBe(80);
      expect(result!.rows).toBe(24);
    });

    it('should floor decimal values', () => {
      const result = normalizeTerminalSize(80.5, 24.7);

      expect(result).not.toBeNull();
      expect(result!.cols).toBe(80);
      expect(result!.rows).toBe(24);
    });

    it('should reject cols too small', () => {
      const result = normalizeTerminalSize(5, 24);

      expect(result).toBeNull();
    });

    it('should reject cols too large', () => {
      const result = normalizeTerminalSize(2001, 24);

      expect(result).toBeNull();
    });

    it('should reject rows too small', () => {
      const result = normalizeTerminalSize(80, 2);

      expect(result).toBeNull();
    });

    it('should reject rows too large', () => {
      const result = normalizeTerminalSize(80, 2001);

      expect(result).toBeNull();
    });

    it('should accept minimum valid values', () => {
      const result = normalizeTerminalSize(10, 5);

      expect(result).not.toBeNull();
      expect(result!.cols).toBe(10);
      expect(result!.rows).toBe(5);
    });

    it('should accept maximum valid values', () => {
      const result = normalizeTerminalSize(2000, 2000);

      expect(result).not.toBeNull();
      expect(result!.cols).toBe(2000);
      expect(result!.rows).toBe(2000);
    });

    it('should reject non-number cols', () => {
      const result = normalizeTerminalSize('80', 24);

      expect(result).toBeNull();
    });

    it('should reject non-number rows', () => {
      const result = normalizeTerminalSize(80, '24');

      expect(result).toBeNull();
    });

    it('should reject NaN', () => {
      const result = normalizeTerminalSize(NaN, 24);

      expect(result).toBeNull();
    });

    it('should reject Infinity', () => {
      const result = normalizeTerminalSize(Infinity, 24);

      expect(result).toBeNull();
    });
  });
});
