import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTerminalFontSize, resolveTerminalFontSize } from '../frontend/src/terminal-layout';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe('terminal font preference', () => {
  it('keeps responsive defaults and accepts only bounded integer sizes', () => {
    expect([390, 844, 1440].map(width => resolveTerminalFontSize(width, true))).toEqual([12, 13, 14]);
    for (const value of [undefined, null, '', '14', 0, 11, 19, 14.5, Infinity, NaN]) {
      expect(parseTerminalFontSize(value)).toBeNull();
    }
    expect(parseTerminalFontSize(12)).toBe(12);
    expect(parseTerminalFontSize(18)).toBe(18);
  });
  it('persists locally, survives viewport changes, and returns to Auto', async () => {
    const values = new Map<string, string>();
    const windowMock = { innerWidth: 390, matchMedia: () => ({ matches: true }), dispatchEvent: vi.fn() };
    vi.stubGlobal('window', windowMock);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const policy = await import('../frontend/src/terminal-layout');
    policy.setTerminalFontPreference(16);
    expect(values.get(policy.TERMINAL_FONT_STORAGE_KEY)).toBe('16');
    windowMock.innerWidth = 844;
    expect(policy.currentTerminalFontSize()).toBe(16);
    policy.setTerminalFontPreference(null);
    expect(policy.currentTerminalFontSize()).toBe(13);
    expect(values.size).toBe(0);
    expect(windowMock.dispatchEvent).toHaveBeenCalledTimes(2);
  });
  it('fails safely on malformed storage and keeps in-memory choice if storage is denied', async () => {
    vi.stubGlobal('window', { innerWidth: 390, matchMedia: () => ({ matches: true }), dispatchEvent: vi.fn() });
    vi.stubGlobal('localStorage', { getItem: () => '99999', setItem: () => { throw new Error('denied'); } });
    const policy = await import('../frontend/src/terminal-layout');
    expect(policy.getTerminalFontPreference()).toBeNull();
    policy.setTerminalFontPreference(15);
    expect(policy.currentTerminalFontSize()).toBe(15);
  });
});
