export const THEME_SCHEMA_VERSION = 2;
export const THEME_MAX_BYTES = 64 * 1024;

export const BUILT_IN_THEME_NAMES = [
  'standard-dark',
  'standard-light',
  'cyberpunk',
  'glacier',
  'gruvbox',
] as const;

export const SAFE_UI_THEME_PROPERTIES = [
  '--bg',
  '--bg-surface',
  '--bg-elevated',
  '--bg-terminal',
  '--text',
  '--text-muted',
  '--text-dim',
  '--accent',
  '--accent-secondary',
  '--accent-secondary-light',
  '--border',
  '--border-strong',
  '--error',
  '--error-bg',
  '--on-accent',
  '--surface-dot',
  '--scrollbar-track',
  '--scrollbar-thumb',
  '--scrollbar-thumb-hover',
  '--scanline-tint',
  '--accent-glow',
  '--accent-bg',
  '--modal-overlay',
  '--on-surface',
  '--on-surface-variant',
  '--agent-user-color',
  '--agent-agent-color',
] as const;

export const SAFE_TERMINAL_THEME_PROPERTIES = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'selectionInactiveBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

const UI_STYLE_NAMES = ['standard', 'cyberpunk', 'soft', 'dense'] as const;
const THEME_SHAPES = ['square', 'rounded', 'soft'] as const;
const THEME_DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
const THEME_FONTS = ['mono', 'system'] as const;
const THEME_SHADOWS = ['none', 'subtle', 'elevated'] as const;
const THEME_MOTIONS = ['none', 'reduced', 'full'] as const;
const BUTTON_STYLES = ['outline', 'solid', 'soft'] as const;
const INPUT_STYLES = ['underline', 'boxed'] as const;
const CARD_STYLES = ['outlined', 'flat', 'elevated'] as const;
const TAB_STYLES = ['underline', 'segmented'] as const;

export type ColorScheme = 'dark' | 'light';
export type BuiltInThemeName = (typeof BUILT_IN_THEME_NAMES)[number];
export type UIStylePresetName = (typeof UI_STYLE_NAMES)[number];
export type ThemeShape = (typeof THEME_SHAPES)[number];
export type ThemeDensity = (typeof THEME_DENSITIES)[number];
export type ThemeFont = (typeof THEME_FONTS)[number];
export type ThemeShadow = (typeof THEME_SHADOWS)[number];
export type ThemeMotion = (typeof THEME_MOTIONS)[number];
export type ThemeButtonStyle = (typeof BUTTON_STYLES)[number];
export type ThemeInputStyle = (typeof INPUT_STYLES)[number];
export type ThemeCardStyle = (typeof CARD_STYLES)[number];
export type ThemeTabStyle = (typeof TAB_STYLES)[number];

export interface ThemeComponentStyles {
  button: ThemeButtonStyle;
  input: ThemeInputStyle;
  card: ThemeCardStyle;
  tabs: ThemeTabStyle;
}

export interface ThemeAppearance {
  style?: UIStylePresetName;
  shape?: ThemeShape;
  density?: ThemeDensity;
  font?: ThemeFont;
  shadow?: ThemeShadow;
  motion?: ThemeMotion;
  components?: Partial<ThemeComponentStyles>;
}

export interface NormalizedThemeData {
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  name?: string;
  baseTheme?: BuiltInThemeName;
  colorScheme: ColorScheme;
  terminal?: Record<string, string>;
  ui?: Record<string, string>;
  appearance?: ThemeAppearance;
}

const SAFE_UI_PROPERTY_SET = new Set<string>(SAFE_UI_THEME_PROPERTIES);
const SAFE_TERMINAL_PROPERTY_SET = new Set<string>(SAFE_TERMINAL_THEME_PROPERTIES);
const BUILT_IN_THEME_SET = new Set<string>(BUILT_IN_THEME_NAMES);

export function normalizeThemeData(data: unknown): NormalizedThemeData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const input = data as Record<string, unknown>;
  const ui = sanitizeColorRecord(input.ui, SAFE_UI_PROPERTY_SET);
  const terminal = sanitizeColorRecord(input.terminal, SAFE_TERMINAL_PROPERTY_SET);
  const appearance = sanitizeThemeAppearance(input.appearance);

  if (!Object.keys(ui).length && !Object.keys(terminal).length && !appearance) return null;

  const baseTheme =
    typeof input.baseTheme === 'string' && BUILT_IN_THEME_SET.has(input.baseTheme)
      ? (input.baseTheme as BuiltInThemeName)
      : undefined;
  const colorScheme =
    input.colorScheme === 'light' || input.colorScheme === 'dark'
      ? input.colorScheme
      : inferColorScheme(ui['--bg'] || terminal.background);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';

  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    ...(name ? { name } : {}),
    ...(baseTheme ? { baseTheme } : {}),
    colorScheme,
    ...(Object.keys(ui).length ? { ui } : {}),
    ...(Object.keys(terminal).length ? { terminal } : {}),
    ...(appearance ? { appearance } : {}),
  };
}

export function isSafeThemeColor(value: string): boolean {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 96 ||
    /url\s*\(|var\s*\(|expression\s*\(/i.test(normalized)
  ) {
    return false;
  }
  return (
    normalized === 'transparent' ||
    /^#[0-9a-f]{3,8}$/i.test(normalized) ||
    /^rgba?\(\s*[\d.\s,%+-]+\)$/i.test(normalized) ||
    /^hsla?\(\s*[\d.\s,%+-]+(?:deg|rad|turn)?[\d.\s,%+-]*\)$/i.test(normalized)
  );
}

function sanitizeColorRecord(
  value: unknown,
  allowedProperties: Set<string>
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([property, color]) =>
        allowedProperties.has(property) && typeof color === 'string' && isSafeThemeColor(color)
    )
  );
}

function sanitizeThemeAppearance(value: unknown): ThemeAppearance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const componentsInput =
    input.components && typeof input.components === 'object' && !Array.isArray(input.components)
      ? (input.components as Record<string, unknown>)
      : {};
  const appearance: ThemeAppearance = {};

  if (isOneOf(input.style, UI_STYLE_NAMES)) appearance.style = input.style;
  if (isOneOf(input.shape, THEME_SHAPES)) appearance.shape = input.shape;
  if (isOneOf(input.density, THEME_DENSITIES)) appearance.density = input.density;
  if (isOneOf(input.font, THEME_FONTS)) appearance.font = input.font;
  if (isOneOf(input.shadow, THEME_SHADOWS)) appearance.shadow = input.shadow;
  if (isOneOf(input.motion, THEME_MOTIONS)) appearance.motion = input.motion;

  const components: Partial<ThemeComponentStyles> = {};
  if (isOneOf(componentsInput.button, BUTTON_STYLES)) components.button = componentsInput.button;
  if (isOneOf(componentsInput.input, INPUT_STYLES)) components.input = componentsInput.input;
  if (isOneOf(componentsInput.card, CARD_STYLES)) components.card = componentsInput.card;
  if (isOneOf(componentsInput.tabs, TAB_STYLES)) components.tabs = componentsInput.tabs;
  if (Object.keys(components).length) appearance.components = components;

  return Object.keys(appearance).length ? appearance : undefined;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function inferColorScheme(background: string | undefined): ColorScheme {
  if (!background || !/^#[0-9a-f]{6}$/i.test(background)) return 'dark';

  const channels = background
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => parseInt(value, 16) / 255);
  const luminance = channels
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  return luminance > 0.5 ? 'light' : 'dark';
}
