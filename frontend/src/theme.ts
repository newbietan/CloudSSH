import type { ITheme } from '@xterm/xterm';

export type ColorScheme = 'dark' | 'light';

export interface ImportedThemeData {
  name?: string;
  colorScheme?: ColorScheme;
  terminal?: ITheme;
  ui?: Record<string, string>;
}

export const THEMES = {
  'standard-dark': {
    background: '#0b0e14',
    foreground: '#d6deeb',
    cursor: '#58a6ff',
    cursorAccent: '#0b0e14',
    selectionBackground: '#264f78',
    selectionInactiveBackground: '#1f3a56',
    black: '#0d1117',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
  'standard-light': {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#0969da',
    cursorAccent: '#ffffff',
    selectionBackground: '#b6d7ff',
    selectionForeground: '#1f2328',
    selectionInactiveBackground: '#dbeafe',
    black: '#24292f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#7d4e00',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#0a6c74',
    brightWhite: '#1f2328',
  },
  cyberpunk: {
    background: '#0a0a0a',
    foreground: '#4af626',
    cursor: '#14d1ff',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#273747',
  },
  glacier: {
    background: '#0a192f',
    foreground: '#64ffda',
    cursor: '#e6f1ff',
    cursorAccent: '#0a192f',
    selectionBackground: '#112240',
  },
  gruvbox: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#d3869b',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
  },
} satisfies Record<string, ITheme>;

export type BuiltInThemeName = keyof typeof THEMES;

export const UI_THEMES: Record<BuiltInThemeName, Record<string, string>> = {
  'standard-dark': {
    '--bg': '#0f1115',
    '--bg-surface': '#161a22',
    '--bg-elevated': '#1c222d',
    '--bg-terminal': '#0b0e14',
    '--text': '#e6edf3',
    '--text-muted': '#9ba7b4',
    '--text-dim': '#7d8590',
    '--accent': '#58a6ff',
    '--accent-secondary': '#79c0ff',
    '--accent-secondary-light': '#a5d6ff',
    '--border': '#30363d',
    '--border-strong': '#484f58',
    '--error': '#ff7b72',
    '--error-bg': '#3d1418',
    '--on-accent': '#07111f',
    '--surface-dot': '#30363d',
    '--scrollbar-track': 'rgba(22, 26, 34, 0.7)',
    '--scrollbar-thumb': 'rgba(155, 167, 180, 0.35)',
    '--scrollbar-thumb-hover': 'rgba(155, 167, 180, 0.55)',
    '--scanline-tint': 'transparent',
    '--accent-glow': 'rgba(88, 166, 255, 0.08)',
    '--accent-bg': 'rgba(88, 166, 255, 0.1)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.72)',
    '--on-surface': '#e6edf3',
    '--on-surface-variant': '#9ba7b4',
    '--agent-user-color': '#58a6ff',
    '--agent-agent-color': '#79c0ff',
  },
  'standard-light': {
    '--bg': '#f6f8fa',
    '--bg-surface': '#ffffff',
    '--bg-elevated': '#eef2f6',
    '--bg-terminal': '#ffffff',
    '--text': '#1f2328',
    '--text-muted': '#57606a',
    '--text-dim': '#656d76',
    '--accent': '#0969da',
    '--accent-secondary': '#0550ae',
    '--accent-secondary-light': '#0550ae',
    '--border': '#d0d7de',
    '--border-strong': '#afb8c1',
    '--error': '#cf222e',
    '--error-bg': '#ffebe9',
    '--on-accent': '#ffffff',
    '--surface-dot': '#eaeef2',
    '--scrollbar-track': 'rgba(208, 215, 222, 0.45)',
    '--scrollbar-thumb': 'rgba(87, 96, 106, 0.35)',
    '--scrollbar-thumb-hover': 'rgba(87, 96, 106, 0.55)',
    '--scanline-tint': 'transparent',
    '--accent-glow': 'rgba(9, 105, 218, 0.08)',
    '--accent-bg': 'rgba(9, 105, 218, 0.1)',
    '--modal-overlay': 'rgba(31, 35, 40, 0.48)',
    '--on-surface': '#1f2328',
    '--on-surface-variant': '#57606a',
    '--agent-user-color': '#0969da',
    '--agent-agent-color': '#8250df',
  },
  cyberpunk: {
    '--bg': '#0a0a0a',
    '--bg-surface': '#121212',
    '--bg-elevated': '#131313',
    '--bg-terminal': '#0e0e0e',
    '--text': '#4af626',
    '--text-muted': '#bbccb0',
    '--text-dim': '#3c4b36',
    '--accent': '#4af626',
    '--accent-secondary': '#14d1ff',
    '--accent-secondary-light': '#b7eaff',
    '--border': '#1f1f1f',
    '--border-strong': '#3c4b36',
    '--error': '#ffb4ab',
    '--error-bg': '#93000a',
    '--on-accent': '#022100',
    '--surface-dot': '#353534',
    '--scrollbar-track': 'rgba(28, 27, 27, 0.5)',
    '--scrollbar-thumb': 'rgba(60, 75, 54, 0.8)',
    '--scrollbar-thumb-hover': 'rgba(134, 149, 125, 0.8)',
    '--scanline-tint': 'rgba(74, 246, 38, 0.02)',
    '--accent-glow': 'rgba(74, 246, 38, 0.08)',
    '--accent-bg': 'rgba(74, 246, 38, 0.1)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.8)',
    '--on-surface': '#e5e2e1',
    '--on-surface-variant': '#bbccb0',
    '--agent-user-color': '#4af626',
    '--agent-agent-color': '#14d1ff',
  },
  glacier: {
    '--bg': '#0a192f',
    '--bg-surface': '#0d2137',
    '--bg-elevated': '#112240',
    '--bg-terminal': '#061526',
    '--text': '#64ffda',
    '--text-muted': '#8892b0',
    '--text-dim': '#495670',
    '--accent': '#64ffda',
    '--accent-secondary': '#e6f1ff',
    '--accent-secondary-light': '#ccd6f6',
    '--border': '#1d3557',
    '--border-strong': '#495670',
    '--error': '#ff6b6b',
    '--error-bg': '#3d0000',
    '--on-accent': '#0a192f',
    '--surface-dot': '#1d3557',
    '--scrollbar-track': 'rgba(10, 25, 47, 0.5)',
    '--scrollbar-thumb': 'rgba(100, 255, 218, 0.2)',
    '--scrollbar-thumb-hover': 'rgba(100, 255, 218, 0.4)',
    '--scanline-tint': 'rgba(100, 255, 218, 0.02)',
    '--accent-glow': 'rgba(100, 255, 218, 0.08)',
    '--accent-bg': 'rgba(100, 255, 218, 0.1)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.85)',
    '--on-surface': '#e6f1ff',
    '--on-surface-variant': '#8892b0',
    '--agent-user-color': '#64ffda',
    '--agent-agent-color': '#e6f1ff',
  },
  gruvbox: {
    '--bg': '#282828',
    '--bg-surface': '#303030',
    '--bg-elevated': '#282828',
    '--bg-terminal': '#1d2021',
    '--text': '#ebdbb2',
    '--text-muted': '#a89984',
    '--text-dim': '#665c54',
    '--accent': '#b8bb26',
    '--accent-secondary': '#83a598',
    '--accent-secondary-light': '#8ec07c',
    '--border': '#3c3836',
    '--border-strong': '#665c54',
    '--error': '#fb4934',
    '--error-bg': '#3d0000',
    '--on-accent': '#282828',
    '--surface-dot': '#3c3836',
    '--scrollbar-track': 'rgba(40, 40, 40, 0.5)',
    '--scrollbar-thumb': 'rgba(168, 153, 132, 0.3)',
    '--scrollbar-thumb-hover': 'rgba(168, 153, 132, 0.5)',
    '--scanline-tint': 'rgba(184, 187, 38, 0.02)',
    '--accent-glow': 'rgba(184, 187, 38, 0.08)',
    '--accent-bg': 'rgba(184, 187, 38, 0.1)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.75)',
    '--on-surface': '#ebdbb2',
    '--on-surface-variant': '#a89984',
    '--agent-user-color': '#b8bb26',
    '--agent-agent-color': '#83a598',
  },
};

const COLOR_SCHEMES: Record<BuiltInThemeName, ColorScheme> = {
  'standard-dark': 'dark',
  'standard-light': 'light',
  cyberpunk: 'dark',
  glacier: 'dark',
  gruvbox: 'dark',
};

let activeTerminalTheme: ITheme = THEMES.cyberpunk;
const terminalThemeListeners = new Set<(theme: ITheme) => void>();

export function isBuiltInTheme(value: string | null): value is BuiltInThemeName {
  return !!value && Object.prototype.hasOwnProperty.call(THEMES, value);
}

export function applyBuiltInTheme(themeName: BuiltInThemeName): void {
  applyTheme(UI_THEMES[themeName], THEMES[themeName], COLOR_SCHEMES[themeName], themeName);
}

export function applyImportedTheme(data: ImportedThemeData): void {
  const colorScheme = data.colorScheme || inferColorScheme(data);
  const fallbackName: BuiltInThemeName = colorScheme === 'light' ? 'standard-light' : 'cyberpunk';
  const validUiEntries = Object.entries(data.ui || {})
    .filter(([property, value]) => property.startsWith('--') && typeof value === 'string');
  const ui = { ...UI_THEMES[fallbackName], ...Object.fromEntries(validUiEntries) };
  const terminal = { ...THEMES[fallbackName], ...(data.terminal || {}) };
  applyTheme(ui, terminal, colorScheme, 'custom');
}

export function getActiveTerminalTheme(): ITheme {
  return activeTerminalTheme;
}

export function onTerminalThemeChange(listener: (theme: ITheme) => void): () => void {
  terminalThemeListeners.add(listener);
  listener(activeTerminalTheme);
  return () => terminalThemeListeners.delete(listener);
}

function applyTheme(
  ui: Record<string, string>,
  terminal: ITheme,
  colorScheme: ColorScheme,
  themeName: BuiltInThemeName | 'custom',
): void {
  activeTerminalTheme = terminal;

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    Object.entries(ui).forEach(([property, value]) => root.style.setProperty(property, value));
    root.dataset.theme = themeName;
    root.dataset.colorScheme = colorScheme;
    root.style.colorScheme = colorScheme;
    root.classList.toggle('dark', colorScheme === 'dark');
  }

  terminalThemeListeners.forEach(listener => listener(terminal));
}

function inferColorScheme(data: ImportedThemeData): ColorScheme {
  const background = data.ui?.['--bg'] || data.terminal?.background;
  if (!background || !/^#[0-9a-f]{6}$/i.test(background)) return 'dark';

  const channels = background.slice(1).match(/.{2}/g)!.map(value => parseInt(value, 16) / 255);
  const luminance = channels
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  return luminance > 0.5 ? 'light' : 'dark';
}
