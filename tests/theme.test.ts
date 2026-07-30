import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUILT_IN_APPEARANCE,
  THEMES,
  THEME_SCHEMA_VERSION,
  UI_THEMES,
  UI_STYLE_PRESETS,
  applyBuiltInTheme,
  applyImportedTheme,
  getActiveColorScheme,
  getActiveTerminalTheme,
  getActiveThemeAppearance,
  isBuiltInTheme,
  onColorSchemeChange,
  onTerminalThemeChange,
  resolveThemeAppearance,
} from '../frontend/src/theme';

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map(value => parseInt(value, 16) / 255);
  return channels
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('Standard 内置主题', () => {
  afterEach(() => applyBuiltInTheme('cyberpunk'));

  it('注册 Standard Dark/Light，并保持全部 UI 变量完整', () => {
    expect(isBuiltInTheme('standard-dark')).toBe(true);
    expect(isBuiltInTheme('standard-light')).toBe(true);
    expect(Object.keys(UI_THEMES['standard-dark']).sort()).toEqual(Object.keys(UI_THEMES.cyberpunk).sort());
    expect(Object.keys(UI_THEMES['standard-light']).sort()).toEqual(Object.keys(UI_THEMES.cyberpunk).sort());
  });

  it('为浅色和深色终端提供完整 ANSI 16 色', () => {
    const ansiKeys = [
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ] as const;

    for (const themeName of ['standard-dark', 'standard-light'] as const) {
      for (const key of ansiKeys) {
        expect(THEMES[themeName][key]).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('主要文本、次要文本和强调色达到普通文字 4.5:1 对比度', () => {
    for (const themeName of ['standard-dark', 'standard-light'] as const) {
      const ui = UI_THEMES[themeName];
      for (const foreground of ['--text', '--text-muted', '--text-dim', '--accent', '--error']) {
        expect(contrastRatio(ui[foreground], ui['--bg'])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('主题变化会广播给所有订阅终端，新订阅者立即获得当前主题', () => {
    const received: unknown[] = [];
    const unsubscribe = onTerminalThemeChange(theme => received.push(theme));

    applyBuiltInTheme('standard-light');
    expect(received).toEqual([THEMES.cyberpunk, THEMES['standard-light']]);
    expect(getActiveTerminalTheme()).toBe(THEMES['standard-light']);

    unsubscribe();
    applyBuiltInTheme('standard-dark');
    expect(received).toHaveLength(2);
  });

  it('主题变化会广播明暗模式，供第三方组件同步配色', () => {
    const received: unknown[] = [];
    const unsubscribe = onColorSchemeChange(colorScheme => received.push(colorScheme));

    applyBuiltInTheme('standard-light');
    expect(received).toEqual(['dark', 'light']);
    expect(getActiveColorScheme()).toBe('light');

    unsubscribe();
    applyBuiltInTheme('standard-dark');
    expect(received).toHaveLength(2);
  });

  it('旧版浅色自定义主题可以推断模式并继承浅色 ANSI 配色', () => {
    applyImportedTheme({
      ui: {
        '--bg': '#ffffff',
        '--text': '#202124',
      },
    });

    expect(getActiveTerminalTheme().background).toBe(THEMES['standard-light'].background);
    expect(getActiveTerminalTheme().yellow).toBe(THEMES['standard-light'].yellow);
    expect(getActiveThemeAppearance().style).toBe('standard');
  });
});

describe('Theme V2 界面风格', () => {
  afterEach(() => applyBuiltInTheme('cyberpunk'));

  it('提供版本化外观结构，并让内置主题覆盖四种风格', () => {
    expect(THEME_SCHEMA_VERSION).toBe(2);
    expect(BUILT_IN_APPEARANCE).toEqual({
      'standard-dark': { style: 'standard' },
      'standard-light': { style: 'standard' },
      cyberpunk: { style: 'cyberpunk' },
      glacier: { style: 'soft' },
      gruvbox: { style: 'dense' },
    });
    expect(Object.keys(UI_STYLE_PRESETS).sort()).toEqual(
      ['cyberpunk', 'dense', 'soft', 'standard'],
    );
  });

  it('切换内置主题会同步形状、密度、字体、阴影、动效和组件风格', () => {
    applyBuiltInTheme('glacier');
    expect(getActiveThemeAppearance()).toEqual({
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
    });

    applyBuiltInTheme('gruvbox');
    expect(getActiveThemeAppearance().style).toBe('dense');
    expect(getActiveThemeAppearance().density).toBe('compact');
    expect(getActiveThemeAppearance().components.card).toBe('flat');
  });

  it('自定义主题可以在预设之上安全覆盖外观枚举', () => {
    applyImportedTheme({
      schemaVersion: 2,
      colorScheme: 'dark',
      ui: { '--bg': '#101318' },
      appearance: {
        style: 'soft',
        shape: 'square',
        density: 'spacious',
        font: 'mono',
        shadow: 'none',
        motion: 'none',
        components: {
          button: 'solid',
          input: 'underline',
          card: 'flat',
          tabs: 'underline',
        },
      },
    });

    expect(getActiveThemeAppearance()).toEqual({
      style: 'soft',
      shape: 'square',
      density: 'spacious',
      font: 'mono',
      shadow: 'none',
      motion: 'none',
      components: {
        button: 'solid',
        input: 'underline',
        card: 'flat',
        tabs: 'underline',
      },
    });
  });

  it('非法外观取值回退到所选预设，不进入页面数据属性', () => {
    const resolved = resolveThemeAppearance({
      style: 'soft',
      shape: 'invalid' as never,
      density: 'invalid' as never,
      components: { button: 'invalid' as never },
    });

    expect(resolved.shape).toBe(UI_STYLE_PRESETS.soft.shape);
    expect(resolved.density).toBe(UI_STYLE_PRESETS.soft.density);
    expect(resolved.components.button).toBe(UI_STYLE_PRESETS.soft.components.button);
  });

  it('终端主题拒绝可触发外部资源请求的 CSS 值', () => {
    applyImportedTheme({
      terminal: {
        background: 'url(https://example.com/tracker.png)',
        foreground: '#abcdef',
      },
    });

    expect(getActiveTerminalTheme().background).toBe(THEMES.cyberpunk.background);
    expect(getActiveTerminalTheme().foreground).toBe('#abcdef');
  });
});

describe('Standard 主题入口和编辑器', () => {
  const appHtml = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const editorHtml = readFileSync(new URL('../docs/theme-editor/index.html', import.meta.url), 'utf8');
  const terminalSource = readFileSync(new URL('../frontend/src/terminal.ts', import.meta.url), 'utf8');
  const appCss = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');

  it('主项目和在线编辑器都提供两个 Standard 主题', () => {
    expect(appHtml).toContain('<option value="standard-dark">Standard Dark</option>');
    expect(appHtml).toContain('<option value="standard-light">Standard Light</option>');
    expect(editorHtml).toContain('<select id="preset-select" class="preset-select">');
    expect(editorHtml).toContain('<option value="standard-dark">Standard Dark</option>');
    expect(editorHtml).toContain('<option value="standard-light">Standard Light</option>');
    expect(editorHtml).toContain("colorScheme: preset?.colorScheme || colorScheme");
  });

  it('用户空间和终端页都可以直接切换主题风格', () => {
    expect(appHtml.match(/data-theme-selector/g)).toHaveLength(2);
    expect(appHtml.match(/data-theme-import/g)).toHaveLength(2);
    expect(appHtml).toContain('Glacier · Soft');
    expect(appHtml).toContain('Gruvbox · Dense');
  });

  it('样式表使用语义令牌实现外观与布局解耦', () => {
    for (const token of [
      '--control-radius',
      '--card-radius',
      '--space-scale',
      '--font-ui',
      '--shadow-card',
      '--motion-normal',
    ]) {
      expect(appCss).toContain(token);
    }
    expect(appCss).toContain('data-component-button');
    expect(appCss).toContain('data-component-input');
    expect(appCss).toContain('data-component-card');
    expect(appCss).toContain('data-component-tabs');
    expect(appCss).not.toContain('data-server-list-layout');
    expect(appCss).not.toContain('data-panel-position');
  });

  it('在线编辑器通过下拉框完整展示和切换全部预设', () => {
    for (const themeName of ['standard-dark', 'standard-light', 'cyberpunk', 'glacier', 'gruvbox']) {
      expect(editorHtml).toContain(`<option value="${themeName}"`);
    }
    expect(editorHtml).toContain("document.getElementById('preset-select').addEventListener('change'");
    expect(editorHtml).toContain("syncThemeSelectors('custom')");
    expect(editorHtml).not.toContain('class="preset-chip"');
  });

  it('在线编辑器与主项目的 Standard UI 预设保持一致', () => {
    for (const themeName of ['standard-dark', 'standard-light'] as const) {
      for (const [property, value] of Object.entries(UI_THEMES[themeName])) {
        expect(editorHtml).toContain(`'${property}': '${value}'`);
      }
    }
  });

  it('终端订阅全局主题并在销毁时解除订阅', () => {
    expect(terminalSource).toContain('onTerminalThemeChange((theme)');
    expect(terminalSource).toContain('this.themeCleanup()');
  });
});
