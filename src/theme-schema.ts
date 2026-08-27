export const THEME_SCHEMA_VERSION = 3;
export const THEME_MAX_BYTES = 64 * 1024;

export const BUILT_IN_THEME_NAMES = [
  'standard-dark',
  'standard-light',
  'cyberpunk',
  'apple',
  'gruvbox',
  'crt',
  'glass',
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
const THEME_BLURS = ['none', 'subtle', 'strong'] as const;
const BUTTON_STYLES = ['outline', 'solid', 'soft'] as const;
const INPUT_STYLES = ['underline', 'boxed'] as const;
const CARD_STYLES = ['outlined', 'flat', 'elevated'] as const;
const TAB_STYLES = ['underline', 'segmented'] as const;
const BACKGROUND_TYPES = ['solid', 'linear', 'radial', 'mesh'] as const;
const BACKGROUND_ANIMATIONS = ['none', 'drift'] as const;
const BACKGROUND_MAX_STOPS = 5;
/** 渐变背景的读性遮罩下限：把背景拉回基色，保证正文对比度不因背景而崩塌 */
const BACKGROUND_SCRIM_FLOOR: Record<ColorScheme, number> = { light: 0.35, dark: 0.25 };
export const THEME_EFFECT_NAMES = ['scanline', 'flicker', 'glow', 'noise'] as const;

export type ColorScheme = 'dark' | 'light';
export type BuiltInThemeName = (typeof BUILT_IN_THEME_NAMES)[number];
export type UIStylePresetName = (typeof UI_STYLE_NAMES)[number];
export type ThemeShape = (typeof THEME_SHAPES)[number];
export type ThemeDensity = (typeof THEME_DENSITIES)[number];
export type ThemeFont = (typeof THEME_FONTS)[number];
export type ThemeShadow = (typeof THEME_SHADOWS)[number];
export type ThemeMotion = (typeof THEME_MOTIONS)[number];
export type ThemeBlur = (typeof THEME_BLURS)[number];
export type ThemeButtonStyle = (typeof BUTTON_STYLES)[number];
export type ThemeInputStyle = (typeof INPUT_STYLES)[number];
export type ThemeCardStyle = (typeof CARD_STYLES)[number];
export type ThemeTabStyle = (typeof TAB_STYLES)[number];
export type ThemeBackgroundType = (typeof BACKGROUND_TYPES)[number];
export type ThemeBackgroundAnimation = (typeof BACKGROUND_ANIMATIONS)[number];

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
  /** 独立于 shadow 档位的表面模糊覆盖（缺省时跟随 shadow 预设派生值） */
  blur?: ThemeBlur;
  components?: Partial<ThemeComponentStyles>;
}

export interface ThemeBackground {
  type: ThemeBackgroundType;
  /** 渐变停靠点（1–5 个，均通过 isSafeThemeColor 白名单校验） */
  stops: string[];
  /** linear 渐变角度，0–360 */
  angle: number;
  /** 读性遮罩强度 0–0.85，渐变背景会被抬到明暗方案对应的下限 */
  scrim: number;
  animation: ThemeBackgroundAnimation;
}

export interface ThemeEffects {
  /** 键存在且 > 0 即启用对应效果，数值为 0–1 的强度参数 */
  scanline?: number;
  flicker?: number;
  glow?: number;
  noise?: number;
}

export interface ThemeTypography {
  /** UI 字号缩放 0.85–1.25，叠加在密度档位基准之上 */
  fontScale: number;
  /** 圆角缩放 0.5–2，叠加在形状档位基准之上 */
  radiusScale: number;
}

export interface NormalizedThemeData {
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  name?: string;
  baseTheme?: BuiltInThemeName;
  colorScheme: ColorScheme;
  terminal?: Record<string, string>;
  ui?: Record<string, string>;
  appearance?: ThemeAppearance;
  background?: ThemeBackground;
  effects?: ThemeEffects;
  typography?: ThemeTypography;
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
  const colorScheme =
    input.colorScheme === 'light' || input.colorScheme === 'dark'
      ? input.colorScheme
      : inferColorScheme(ui['--bg'] || terminal.background);
  const background = sanitizeBackground(input.background, colorScheme);
  const effects = sanitizeEffects(input.effects);
  const typography = sanitizeTypography(input.typography);

  if (
    !Object.keys(ui).length &&
    !Object.keys(terminal).length &&
    !appearance &&
    !background &&
    !effects &&
    !typography
  ) {
    return null;
  }

  const baseTheme =
    typeof input.baseTheme === 'string' && BUILT_IN_THEME_SET.has(input.baseTheme)
      ? (input.baseTheme as BuiltInThemeName)
      : undefined;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';

  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    ...(name ? { name } : {}),
    ...(baseTheme ? { baseTheme } : {}),
    colorScheme,
    ...(Object.keys(ui).length ? { ui } : {}),
    ...(Object.keys(terminal).length ? { terminal } : {}),
    ...(appearance ? { appearance } : {}),
    ...(background ? { background } : {}),
    ...(effects ? { effects } : {}),
    ...(typography ? { typography } : {}),
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
  if (isOneOf(input.blur, THEME_BLURS)) appearance.blur = input.blur;

  const components: Partial<ThemeComponentStyles> = {};
  if (isOneOf(componentsInput.button, BUTTON_STYLES)) components.button = componentsInput.button;
  if (isOneOf(componentsInput.input, INPUT_STYLES)) components.input = componentsInput.input;
  if (isOneOf(componentsInput.card, CARD_STYLES)) components.card = componentsInput.card;
  if (isOneOf(componentsInput.tabs, TAB_STYLES)) components.tabs = componentsInput.tabs;
  if (Object.keys(components).length) appearance.components = components;

  return Object.keys(appearance).length ? appearance : undefined;
}

function sanitizeBackground(value: unknown, colorScheme: ColorScheme): ThemeBackground | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const stops = Array.isArray(input.stops)
    ? input.stops
        .filter((stop): stop is string => typeof stop === 'string' && isSafeThemeColor(stop))
        .slice(0, BACKGROUND_MAX_STOPS)
    : [];
  // 背景模块存在但没有任何合法停靠点：整块丢弃，回退纯色背景
  if (stops.length === 0) return undefined;
  const type = isOneOf(input.type, BACKGROUND_TYPES) ? input.type : 'linear';
  const animation = isOneOf(input.animation, BACKGROUND_ANIMATIONS)
    ? input.animation
    : ('none' as const);
  const angle = clampFinite(input.angle, 0, 360, 160);
  let scrim = clampFinite(input.scrim, 0, 0.85, 0);
  if (type !== 'solid') {
    scrim = Math.max(scrim, BACKGROUND_SCRIM_FLOOR[colorScheme]);
  }
  return { type, stops, angle, scrim, animation };
}

function sanitizeEffects(value: unknown): ThemeEffects | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const effects: ThemeEffects = {};
  for (const name of THEME_EFFECT_NAMES) {
    const raw = input[name];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const clamped = Math.min(1, Math.max(0, raw));
      if (clamped > 0) effects[name] = clamped;
    }
  }
  return Object.keys(effects).length ? effects : undefined;
}

function sanitizeTypography(value: unknown): ThemeTypography | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const fontScale = clampFinite(input.fontScale, 0.85, 1.25, 1);
  const radiusScale = clampFinite(input.radiusScale, 0.5, 2, 1);
  if (fontScale === 1 && radiusScale === 1) return undefined;
  return { fontScale, radiusScale };
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
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
