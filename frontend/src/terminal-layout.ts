export function resolveTerminalFontSize(viewportWidth: number, coarsePointer: boolean): number {
  if (viewportWidth < 768) return 12;
  if (viewportWidth <= 1180 && coarsePointer) return 13;
  return 14;
}

export const TERMINAL_FONT_CHANGE_EVENT = 'cloudssh:terminal-font-change';
export const TERMINAL_FONT_STORAGE_KEY = 'cloudssh_terminal_font_size';
export const MIN_TERMINAL_FONT_SIZE = 12;
export const MAX_TERMINAL_FONT_SIZE = 18;
let preference: number | null | undefined;

export function parseTerminalFontSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= MIN_TERMINAL_FONT_SIZE && value <= MAX_TERMINAL_FONT_SIZE ? value : null;
}

export function getTerminalFontPreference(): number | null {
  if (preference === undefined) {
    try {
      const stored = localStorage.getItem(TERMINAL_FONT_STORAGE_KEY);
      preference = stored === null ? null : parseTerminalFontSize(Number(stored));
    } catch { preference = null; }
  }
  return preference;
}

export function setTerminalFontPreference(value: number | null): void {
  preference = parseTerminalFontSize(value);
  try {
    if (preference === null) localStorage.removeItem(TERMINAL_FONT_STORAGE_KEY);
    else localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, String(preference));
  } catch { /* Per-page preference still works when storage is unavailable. */ }
  window.dispatchEvent(new Event(TERMINAL_FONT_CHANGE_EVENT));
}

export function currentTerminalFontSize(): number {
  return getTerminalFontPreference() ??
    resolveTerminalFontSize(window.innerWidth, window.matchMedia('(pointer: coarse)').matches);
}
