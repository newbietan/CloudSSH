import type { ITheme } from '@xterm/xterm';
import {
  type BuiltInThemeName,
  type ColorScheme,
  type NormalizedThemeData,
  normalizeThemeData,
  type ThemeBackground,
  type ThemeEffects,
  type ThemeTypography,
  type ThemeAppearance,
  type ThemeBlur,
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
  type ThemeBackground,
  type ThemeEffects,
  type ThemeTypography,
  THEME_MAX_BYTES,
  THEME_SCHEMA_VERSION,
  type ThemeAppearance,
  type ThemeBlur,
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
  blur: ThemeBlur;
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
    blur: 'subtle',
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
    blur: 'none',
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
    blur: 'strong',
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
    blur: 'none',
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
  crt: {
    background: '#0f0a00',
    foreground: '#ffb000',
    cursor: '#ffd257',
    cursorAccent: '#0f0a00',
    selectionBackground: '#3d2e00',
    selectionForeground: '#ffb000',
    selectionInactiveBackground: '#2a2000',
    black: '#241a00',
    red: '#ff6b4a',
    green: '#d4a017',
    yellow: '#ffb000',
    blue: '#f0c040',
    magenta: '#e08e39',
    cyan: '#c8b04a',
    white: '#d9c08a',
    brightBlack: '#8a7440',
    brightRed: '#ffa080',
    brightGreen: '#ffd257',
    brightYellow: '#ffe08a',
    brightBlue: '#ffe8b0',
    brightMagenta: '#ffc27a',
    brightCyan: '#e8d89a',
    brightWhite: '#fff3c4',
  },
  glass: {
    background: '#ffffff',
    foreground: '#1a2332',
    cursor: '#235cd8',
    cursorAccent: '#ffffff',
    selectionBackground: '#c4d8f7',
    selectionForeground: '#1a2332',
    selectionInactiveBackground: '#dde8f7',
    black: '#1a2332',
    red: '#c03528',
    green: '#1e7d3c',
    yellow: '#8a5a00',
    blue: '#235cd8',
    magenta: '#7c4dcc',
    cyan: '#0e6e86',
    white: '#56637a',
    brightBlack: '#56637a',
    brightRed: '#d9483b',
    brightGreen: '#2a944f',
    brightYellow: '#a86e10',
    brightBlue: '#3870e8',
    brightMagenta: '#8f5ce6',
    brightCyan: '#2a8ba3',
    brightWhite: '#0e1626',
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
  crt: {
    '--bg': '#0f0a00',
    '--bg-surface': '#171000',
    '--bg-elevated': '#1d1600',
    '--bg-terminal': '#0f0a00',
    '--text': '#ffb000',
    '--text-muted': '#bfa06a',
    '--text-dim': '#937c46',
    '--accent': '#ffb000',
    '--accent-secondary': '#ffd257',
    '--accent-secondary-light': '#ffe08a',
    '--border': '#3d2e00',
    '--border-strong': '#5c470a',
    '--error': '#ff6b4a',
    '--error-bg': '#3d1200',
    '--on-accent': '#0f0a00',
    '--surface-dot': '#3d2e00',
    '--scrollbar-track': 'rgba(23, 16, 0, 0.5)',
    '--scrollbar-thumb': 'rgba(255, 176, 0, 0.25)',
    '--scrollbar-thumb-hover': 'rgba(255, 176, 0, 0.45)',
    '--scanline-tint': 'rgba(255, 176, 0, 0.03)',
    '--accent-glow': 'rgba(255, 176, 0, 0.12)',
    '--accent-bg': 'rgba(255, 176, 0, 0.12)',
    '--modal-overlay': 'rgba(0, 0, 0, 0.8)',
    '--on-surface': '#fff3c4',
    '--on-surface-variant': '#bfa06a',
    '--agent-user-color': '#ffb000',
    '--agent-agent-color': '#ffd257',
  },
  glass: {
    '--bg': '#e8edf5',
    '--bg-surface': '#f4f7fb',
    '--bg-elevated': '#ffffff',
    '--bg-terminal': '#ffffff',
    '--text': '#1a2332',
    '--text-muted': '#4d5a70',
    '--text-dim': '#56637a',
    '--accent': '#235cd8',
    '--accent-secondary': '#3870e8',
    '--accent-secondary-light': '#c4d8f7',
    '--border': '#c9d4e3',
    '--border-strong': '#a9b8cc',
    '--error': '#c03528',
    '--error-bg': '#f9e3e0',
    '--on-accent': '#ffffff',
    '--surface-dot': '#d5deea',
    '--scrollbar-track': 'rgba(201, 212, 227, 0.45)',
    '--scrollbar-thumb': 'rgba(77, 90, 112, 0.3)',
    '--scrollbar-thumb-hover': 'rgba(77, 90, 112, 0.5)',
    '--scanline-tint': 'transparent',
    '--accent-glow': 'rgba(35, 92, 216, 0.1)',
    '--accent-bg': 'rgba(35, 92, 216, 0.08)',
    '--modal-overlay': 'rgba(26, 35, 50, 0.35)',
    '--on-surface': '#1a2332',
    '--on-surface-variant': '#4d5a70',
    '--agent-user-color': '#235cd8',
    '--agent-agent-color': '#7c4dcc',
  },
};

export const BUILT_IN_APPEARANCE: Record<BuiltInThemeName, ThemeAppearance> = {
  'standard-dark': { style: 'standard' },
  'standard-light': { style: 'standard' },
  cyberpunk: { style: 'cyberpunk' },
  apple: { style: 'soft' },
  gruvbox: { style: 'dense' },
  crt: { style: 'cyberpunk' },
  glass: { style: 'soft', blur: 'strong' },
};

const COLOR_SCHEMES: Record<BuiltInThemeName, ColorScheme> = {
  'standard-dark': 'dark',
  'standard-light': 'light',
  cyberpunk: 'dark',
  apple: 'light',
  gruvbox: 'dark',
  crt: 'dark',
  glass: 'light',
};

/** V3 内置主题的背景层配置（未列出的主题保持纯色背景） */
export const BUILT_IN_BACKGROUND: Partial<Record<BuiltInThemeName, ThemeBackground>> = {
  cyberpunk: {
    type: 'linear',
    stops: ['#0a0a0a', '#11170c'],
    angle: 165,
    scrim: 0.3,
    animation: 'none',
  },
  crt: {
    type: 'radial',
    stops: ['#261b00', '#0f0a00'],
    angle: 160,
    scrim: 0.3,
    animation: 'none',
  },
  glass: {
    type: 'mesh',
    stops: ['#d3e3f8', '#e8edf5', '#ece0f6'],
    angle: 135,
    scrim: 0.35,
    animation: 'drift',
  },
};

/** V3 内置主题的效果配置（键存在且 >0 即启用） */
export const BUILT_IN_EFFECTS: Partial<Record<BuiltInThemeName, ThemeEffects>> = {
  cyberpunk: { scanline: 1, flicker: 1 },
  crt: { scanline: 1, flicker: 0.6, glow: 0.5 },
  glass: { glow: 0.4 },
};

/** V3 内置主题的版式缩放（缺省 1/1） */
export const BUILT_IN_TYPOGRAPHY: Partial<Record<BuiltInThemeName, ThemeTypography>> = {
  crt: { fontScale: 1, radiusScale: 0.75 },
  glass: { fontScale: 1.05, radiusScale: 1.4 },
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
    resolveThemeAppearance(BUILT_IN_APPEARANCE[themeName]),
    BUILT_IN_BACKGROUND[themeName],
    BUILT_IN_EFFECTS[themeName],
    BUILT_IN_TYPOGRAPHY[themeName]
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
  const background = normalized.background ?? BUILT_IN_BACKGROUND[fallbackName];
  const effects = { ...BUILT_IN_EFFECTS[fallbackName], ...normalized.effects };
  const typography = normalized.typography ?? BUILT_IN_TYPOGRAPHY[fallbackName];
  applyTheme(ui, terminal, colorScheme, 'custom', appearance, background, effects, typography);
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
  appearance: ResolvedThemeAppearance,
  background?: ThemeBackground,
  effects?: ThemeEffects,
  typography?: ThemeTypography
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
    root.dataset.uiBlur = appearance.blur;
    root.dataset.componentButton = appearance.components.button;
    root.dataset.componentInput = appearance.components.input;
    root.dataset.componentCard = appearance.components.card;
    root.dataset.componentTabs = appearance.components.tabs;
    root.style.colorScheme = colorScheme;
    root.classList.toggle('dark', colorScheme === 'dark');
    applyThemeV3Layers(root, background, effects, typography, colorScheme);
  }

  terminalThemeListeners.forEach((listener) => {
    listener(terminal);
  });
  colorSchemeListeners.forEach((listener) => {
    listener(colorScheme);
  });
}

/** V3 增量层：背景/效果/版式缩放全部走变量与 data 属性，不碰 DOM 结构 */
function applyThemeV3Layers(
  root: HTMLElement,
  background: ThemeBackground | undefined,
  effects: ThemeEffects | undefined,
  typography: ThemeTypography | undefined,
  colorScheme: ColorScheme
): void {
  root.style.setProperty('--app-bg-stack', resolveBackgroundStack(background, colorScheme));
  root.dataset.bgAnimation =
    background && background.animation === 'drift' && background.type !== 'solid'
      ? 'drift'
      : 'none';

  root.dataset.fxScanline = effects?.scanline ? 'on' : 'off';
  root.dataset.fxFlicker = effects?.flicker ? 'on' : 'off';
  root.dataset.fxGlow = effects?.glow ? 'on' : 'off';
  root.dataset.fxNoise = effects?.noise ? 'on' : 'off';
  root.style.setProperty('--fx-scanline-opacity', String(effects?.scanline ?? 1));
  // 闪烁频率随强度在 0.32s–0.12s 之间收紧
  root.style.setProperty('--fx-flicker-speed', `${0.32 - 0.2 * (effects?.flicker ?? 1)}s`);
  root.style.setProperty('--fx-glow-strength', String(effects?.glow ?? 0.6));
  root.style.setProperty('--fx-noise-opacity', String(effects?.noise ?? 0.05));

  root.style.setProperty('--radius-scale', String(typography?.radiusScale ?? 1));
  root.style.setProperty('--type-scale', String(typography?.fontScale ?? 1));
}

/** 合成含读性遮罩的完整背景栈；无渐变时为 none，body 的 --bg 纯色兜底 */
function resolveBackgroundStack(
  background: ThemeBackground | undefined,
  colorScheme: ColorScheme
): string {
  if (!background || background.type === 'solid' || background.stops.length < 2) return 'none';
  const channel = colorScheme === 'dark' ? '0, 0, 0' : '255, 255, 255';
  const scrim = `linear-gradient(rgba(${channel}, ${background.scrim}), rgba(${channel}, ${background.scrim}))`;
  return `${scrim}, ${resolveBackgroundCss(background)}`;
}

/** 由 schema 背景配置合成 CSS 渐变串（停靠点均已过白名单校验，拼接安全） */
export function resolveBackgroundCss(background: ThemeBackground | undefined): string {
  if (!background || background.type === 'solid' || background.stops.length < 2) {
    return 'var(--bg)';
  }
  switch (background.type) {
    case 'linear':
      return `linear-gradient(${background.angle}deg, ${background.stops.join(', ')})`;
    case 'radial':
      return `radial-gradient(ellipse at 50% 25%, ${background.stops.join(', ')})`;
    case 'mesh': {
      const [first, second, third] = background.stops;
      return [
        `radial-gradient(at 18% 22%, ${first} 0px, transparent 55%)`,
        `radial-gradient(at 82% 28%, ${second ?? first} 0px, transparent 50%)`,
        `radial-gradient(at 50% 88%, ${third ?? second ?? first} 0px, transparent 60%)`,
      ].join(', ');
    }
  }
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
    blur: isOneOf(appearance?.blur, ['none', 'subtle', 'strong'])
      ? appearance.blur
      : preset.blur,
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
