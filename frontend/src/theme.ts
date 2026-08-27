import type { ITheme } from '@xterm/xterm';
import {
  type BuiltInThemeName,
  type ColorScheme,
  type NormalizedThemeData,
  normalizeThemeData,
  THEME_SCHEMA_VERSION,
  type ThemeAppearance,
  type ThemeComponentStyles,
  type ThemeDensity,
  type ThemeFont,
  type ThemeMotion,
  type ThemeShadow,
  type ThemeShape,
  type UIStylePresetName,
} from '../../src/theme-schema';

export {
  type BuiltInThemeName,
  type ColorScheme,
  THEME_MAX_BYTES,
  THEME_SCHEMA_VERSION,
  type ThemeAppearance,
  type ThemeComponentStyles,
  type ThemeDensity,
  type ThemeFont,
  type ThemeMotion,
  type ThemeShadow,
  type ThemeShape,
  type UIStylePresetName,
} from '../../src/theme-schema';

export interface ResolvedThemeAppearance {
  style: UIStylePresetName;
  shape: ThemeShape;
  density: ThemeDensity;
  font: ThemeFont;
  shadow: ThemeShadow;
  motion: ThemeMotion;
  components: ThemeComponentStyles;
}

export type ImportedThemeData = Omit<
  NormalizedThemeData,
  'schemaVersion' | 'colorScheme' | 'terminal'
> & {
  schemaVersion?: number;
  colorScheme?: ColorScheme;
  terminal?: ITheme;
};

export const UI_STYLE_PRESETS: Record<UIStylePresetName, ResolvedThemeAppearance> = {
  standard: {
    style: 'standard',
    shape: 'rounded',
    density: 'comfortable',
    font: 'system',
    shadow: 'subtle',
    motion: 'reduced',
    components: {
      button: 'solid',
      input: 'boxed',
      card: 'outlined',
      tabs: 'underline',
    },
  },
  cyberpunk: {
    style: 'cyberpunk',
    shape: 'square',
    density: 'compact',
    font: 'mono',
    shadow: 'none',
    motion: 'full',
    components: {
      button: 'outline',
      input: 'underline',
      card: 'outlined',
      tabs: 'underline',
    },
  },
  soft: {
    style: 'soft',
    shape: 'soft',
    density: 'comfortable',
    font: 'system',
    shadow: 'elevated',
    motion: 'reduced',
    components: {
      button: 'soft',
      input: 'boxed',
      card: 'elevated',
      tabs: 'segmented',
    },
  },
  dense: {
    style: 'dense',
    shape: 'rounded',
    density: 'compact',
    font: 'mono',
    shadow: 'none',
    motion: 'reduced',
    components: {
      button: 'outline',
      input: 'boxed',
      card: 'flat',
      tabs: 'segmented',
    },
  },
};

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
  apple: {
    background: '#ffffff',
    foreground: '#1d1d1f',
    cursor: '#0066da',
    cursorAccent: '#ffffff',
    selectionBackground: '#b3d7ff',
    selectionForeground: '#1d1d1f',
    selectionInactiveBackground: '#dde8f7',
    black: '#1d1d1f',
    red: '#d70015',
    green: '#248a3d',
    yellow: '#b25000',
    blue: '#0040dd',
    magenta: '#8944ab',
    cyan: '#0b7285',
    white: '#8e8e93',
    brightBlack: '#6e6e73',
    brightRed: '#ff3b30',
    brightGreen: '#34c759',
    brightYellow: '#c93400',
    brightBlue: '#0071e3',
    brightMagenta: '#af52de',
    brightCyan: '#30b0c7',
    brightWhite: '#1d1d1f',
  },
  gruvbox: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#d3869b',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
  },
} satisfies Record<string, ITheme>;

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
  apple: {
    '--bg': '#f5f5f7',
    '--bg-surface': '#ffffff',
    '--bg-elevated': '#ffffff',
    '--bg-terminal': '#ffffff',
    '--text': '#1d1d1f',
    '--text-muted': '#636368',
    '--text-dim': '#6e6e73',
    '--accent': '#0066da',
    '--accent-secondary': '#0052b4',
    '--accent-secondary-light': '#cce4ff',
    '--border': '#d2d2d7',
    '--border-strong': '#aeaeb2',
    '--error': '#d70015',
    '--error-bg': '#ffebe9',
    '--on-accent': '#ffffff',
    '--surface-dot': '#e8e8ed',
    '--scrollbar-track': 'rgba(210, 210, 215, 0.45)',
    '--scrollbar-thumb': 'rgba(99, 99, 104, 0.35)',
    '--scrollbar-thumb-hover': 'rgba(99, 99, 104, 0.55)',
    '--scanline-tint': 'transparent',
    '--accent-glow': 'rgba(0, 102, 218, 0.08)',
    '--accent-bg': 'rgba(0, 102, 218, 0.1)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.32)',
    '--on-surface': '#1d1d1f',
    '--on-surface-variant': '#636368',
    '--agent-user-color': '#0066da',
    '--agent-agent-color': '#5856d6',
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

export const BUILT_IN_APPEARANCE: Record<BuiltInThemeName, ThemeAppearance> = {
  'standard-dark': { style: 'standard' },
  'standard-light': { style: 'standard' },
  cyberpunk: { style: 'cyberpunk' },
  apple: { style: 'soft' },
  gruvbox: { style: 'dense' },
};

const COLOR_SCHEMES: Record<BuiltInThemeName, ColorScheme> = {
  'standard-dark': 'dark',
  'standard-light': 'light',
  cyberpunk: 'dark',
  apple: 'light',
  gruvbox: 'dark',
};

let activeTerminalTheme: ITheme = THEMES.cyberpunk;
let activeColorScheme: ColorScheme = 'dark';
let activeAppearance: ResolvedThemeAppearance = UI_STYLE_PRESETS.cyberpunk;
const terminalThemeListeners = new Set<(theme: ITheme) => void>();
const colorSchemeListeners = new Set<(colorScheme: ColorScheme) => void>();

export function isBuiltInTheme(value: string | null): value is BuiltInThemeName {
  return !!value && Object.hasOwn(THEMES, value);
}

export function applyBuiltInTheme(themeName: BuiltInThemeName): void {
  applyTheme(
    UI_THEMES[themeName],
    THEMES[themeName],
    COLOR_SCHEMES[themeName],
    themeName,
    resolveThemeAppearance(BUILT_IN_APPEARANCE[themeName])
  );
}

export function applyImportedTheme(data: ImportedThemeData): void {
  const normalized = normalizeImportedTheme(data);
  if (!normalized) return;
  const colorScheme = normalized.colorScheme ?? 'dark';
  const fallbackName =
    normalized.baseTheme || (colorScheme === 'light' ? 'standard-light' : 'cyberpunk');
  const ui = { ...UI_THEMES[fallbackName], ...normalized.ui };
  const terminal = { ...THEMES[fallbackName], ...normalized.terminal };
  const fallbackAppearance = resolveThemeAppearance(BUILT_IN_APPEARANCE[fallbackName]);
  const appearance = resolveThemeAppearance(normalized.appearance, fallbackAppearance);
  applyTheme(ui, terminal, colorScheme, 'custom', appearance);
}

export function normalizeImportedTheme(data: unknown): ImportedThemeData | null {
  return normalizeThemeData(data) as ImportedThemeData | null;
}

export function getActiveTerminalTheme(): ITheme {
  return activeTerminalTheme;
}

export function getActiveColorScheme(): ColorScheme {
  return activeColorScheme;
}

export function getActiveThemeAppearance(): ResolvedThemeAppearance {
  return activeAppearance;
}

export function onTerminalThemeChange(listener: (theme: ITheme) => void): () => void {
  terminalThemeListeners.add(listener);
  listener(activeTerminalTheme);
  return () => terminalThemeListeners.delete(listener);
}

export function onColorSchemeChange(listener: (colorScheme: ColorScheme) => void): () => void {
  colorSchemeListeners.add(listener);
  listener(activeColorScheme);
  return () => colorSchemeListeners.delete(listener);
}

function applyTheme(
  ui: Record<string, string>,
  terminal: ITheme,
  colorScheme: ColorScheme,
  themeName: BuiltInThemeName | 'custom',
  appearance: ResolvedThemeAppearance
): void {
  activeTerminalTheme = terminal;
  activeColorScheme = colorScheme;
  activeAppearance = appearance;

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    Object.entries(ui).forEach(([property, value]) => {
      root.style.setProperty(property, value);
    });
    root.dataset.theme = themeName;
    root.dataset.colorScheme = colorScheme;
    root.dataset.uiStyle = appearance.style;
    root.dataset.uiShape = appearance.shape;
    root.dataset.uiDensity = appearance.density;
    root.dataset.uiFont = appearance.font;
    root.dataset.uiShadow = appearance.shadow;
    root.dataset.uiMotion = appearance.motion;
    root.dataset.componentButton = appearance.components.button;
    root.dataset.componentInput = appearance.components.input;
    root.dataset.componentCard = appearance.components.card;
    root.dataset.componentTabs = appearance.components.tabs;
    root.style.colorScheme = colorScheme;
    root.classList.toggle('dark', colorScheme === 'dark');
  }

  terminalThemeListeners.forEach((listener) => {
    listener(terminal);
  });
  colorSchemeListeners.forEach((listener) => {
    listener(colorScheme);
  });
}

export function resolveThemeAppearance(
  appearance?: ThemeAppearance,
  fallback: ResolvedThemeAppearance = UI_STYLE_PRESETS.cyberpunk
): ResolvedThemeAppearance {
  const requestedStyle = isUIStylePresetName(appearance?.style) ? appearance.style : fallback.style;
  const preset = UI_STYLE_PRESETS[requestedStyle];

  return {
    style: requestedStyle,
    shape: isOneOf(appearance?.shape, ['square', 'rounded', 'soft'])
      ? appearance.shape
      : preset.shape,
    density: isOneOf(appearance?.density, ['compact', 'comfortable', 'spacious'])
      ? appearance.density
      : preset.density,
    font: isOneOf(appearance?.font, ['mono', 'system']) ? appearance.font : preset.font,
    shadow: isOneOf(appearance?.shadow, ['none', 'subtle', 'elevated'])
      ? appearance.shadow
      : preset.shadow,
    motion: isOneOf(appearance?.motion, ['none', 'reduced', 'full'])
      ? appearance.motion
      : preset.motion,
    components: {
      button: isOneOf(appearance?.components?.button, ['outline', 'solid', 'soft'])
        ? appearance.components.button
        : preset.components.button,
      input: isOneOf(appearance?.components?.input, ['underline', 'boxed'])
        ? appearance.components.input
        : preset.components.input,
      card: isOneOf(appearance?.components?.card, ['outlined', 'flat', 'elevated'])
        ? appearance.components.card
        : preset.components.card,
      tabs: isOneOf(appearance?.components?.tabs, ['underline', 'segmented'])
        ? appearance.components.tabs
        : preset.components.tabs,
    },
  };
}

function isUIStylePresetName(value: unknown): value is UIStylePresetName {
  return typeof value === 'string' && Object.hasOwn(UI_STYLE_PRESETS, value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
