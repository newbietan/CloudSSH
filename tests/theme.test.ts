import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyBuiltInTheme,
  applyImportedTheme,
  BUILT_IN_APPEARANCE,
  BUILT_IN_BACKGROUND,
  BUILT_IN_EFFECTS,
  BUILT_IN_TYPOGRAPHY,
  getActiveColorScheme,
  getActiveTerminalTheme,
  getActiveThemeAppearance,
  isBuiltInTheme,
  normalizeImportedTheme,
  onColorSchemeChange,
  onTerminalThemeChange,
  resolveBackgroundCss,
  resolveThemeAppearance,
  THEME_SCHEMA_VERSION,
  THEMES,
  UI_STYLE_PRESETS,
  UI_THEMES,
} from '../frontend/src/theme';
import { SAFE_UI_THEME_PROPERTIES, THEME_MAX_BYTES } from '../src/theme-schema';

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => parseInt(value, 16) / 255);
  return channels
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
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
    expect(Object.keys(UI_THEMES['standard-dark']).sort()).toEqual(
      Object.keys(UI_THEMES.cyberpunk).sort()
    );
    expect(Object.keys(UI_THEMES['standard-light']).sort()).toEqual(
      Object.keys(UI_THEMES.cyberpunk).sort()
    );
  });

  it('为浅色和深色终端提供完整 ANSI 16 色', () => {
    const ansiKeys = [
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

    for (const themeName of ['standard-dark', 'standard-light', 'apple', 'crt', 'glass'] as const) {
      for (const key of ansiKeys) {
        expect(THEMES[themeName][key]).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('主要文本、次要文本和强调色达到普通文字 4.5:1 对比度', () => {
    for (const themeName of ['standard-dark', 'standard-light', 'apple', 'crt', 'glass'] as const) {
      const ui = UI_THEMES[themeName];
      for (const foreground of ['--text', '--text-muted', '--text-dim', '--accent', '--error']) {
        expect(contrastRatio(ui[foreground], ui['--bg'])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('主题变化会广播给所有订阅终端，新订阅者立即获得当前主题', () => {
    const received: unknown[] = [];
    const unsubscribe = onTerminalThemeChange((theme) => received.push(theme));

    applyBuiltInTheme('standard-light');
    expect(received).toEqual([THEMES.cyberpunk, THEMES['standard-light']]);
    expect(getActiveTerminalTheme()).toBe(THEMES['standard-light']);

    unsubscribe();
    applyBuiltInTheme('standard-dark');
    expect(received).toHaveLength(2);
  });

  it('主题变化会广播明暗模式，供第三方组件同步配色', () => {
    const received: unknown[] = [];
    const unsubscribe = onColorSchemeChange((colorScheme) => received.push(colorScheme));

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
    expect(THEME_SCHEMA_VERSION).toBe(3);
    expect(BUILT_IN_APPEARANCE).toEqual({
      'standard-dark': { style: 'standard' },
      'standard-light': { style: 'standard' },
      cyberpunk: { style: 'cyberpunk' },
      apple: { style: 'soft' },
      gruvbox: { style: 'dense' },
      crt: { style: 'cyberpunk' },
      glass: { style: 'soft', blur: 'strong' },
    });
    expect(Object.keys(UI_STYLE_PRESETS).sort()).toEqual([
      'cyberpunk',
      'dense',
      'soft',
      'standard',
    ]);
  });

  it('切换内置主题会同步形状、密度、字体、阴影、动效和组件风格', () => {
    applyBuiltInTheme('apple');
    expect(getActiveThemeAppearance()).toEqual({
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
      blur: 'strong',
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

  it('导入时规范化 Theme V2 并保留合法的基础主题和外观配置', () => {
    expect(
      normalizeImportedTheme({
        schemaVersion: 999,
        name: ' My Theme ',
        baseTheme: 'gruvbox',
        colorScheme: 'dark',
        ui: {
          '--accent': '#abcdef',
          '--unknown': '#ffffff',
        },
        appearance: {
          shape: 'soft',
          motion: 'invalid',
          components: { button: 'solid', tabs: 'invalid' },
        },
      })
    ).toEqual({
      schemaVersion: 3,
      name: 'My Theme',
      baseTheme: 'gruvbox',
      colorScheme: 'dark',
      ui: { '--accent': '#abcdef' },
      appearance: {
        shape: 'soft',
        components: { button: 'solid' },
      },
    });
  });

  it('旧版 glacier 基础主题优雅降级：字段被丢弃但主题仍可导入', () => {
    expect(
      normalizeImportedTheme({
        schemaVersion: 2,
        name: 'Legacy Glacier Custom',
        baseTheme: 'glacier',
        colorScheme: 'dark',
        ui: { '--accent': '#67e8f9' },
        appearance: { style: 'soft' },
      })
    ).toEqual({
      schemaVersion: 3,
      name: 'Legacy Glacier Custom',
      colorScheme: 'dark',
      ui: { '--accent': '#67e8f9' },
      appearance: { style: 'soft' },
    });
  });

  it('应用与服务端共享 UI 属性白名单，并拒绝 UI 中的外部资源值', () => {
    expect([...SAFE_UI_THEME_PROPERTIES].sort()).toEqual(Object.keys(UI_THEMES.cyberpunk).sort());
    expect(
      normalizeImportedTheme({
        ui: {
          '--accent': '#abcdef',
          '--bg': 'url(https://example.com/tracker.png)',
        },
      })
    ).toMatchObject({
      ui: { '--accent': '#abcdef' },
    });
  });
});

describe('Standard 主题入口和编辑器', () => {
  const appHtml = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const editorHtml = readFileSync(
    new URL('../docs/theme-editor/index.html', import.meta.url),
    'utf8'
  );
  const terminalSource = readFileSync(
    new URL('../frontend/src/terminal.ts', import.meta.url),
    'utf8'
  );
  const appCss = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('../frontend/src/main.ts', import.meta.url), 'utf8');
  const workerSource = readFileSync(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
  const userDbSource = readFileSync(new URL('../src/worker/user-db.ts', import.meta.url), 'utf8');
  const presetJson = editorHtml.match(
    /\/\* THEME_PRESETS_START \*\/ ([\s\S]+?) \/\* THEME_PRESETS_END \*\//
  )?.[1];
  const editorPresets = JSON.parse(presetJson || '{}') as Record<
    string,
    {
      ui: Record<string, string>;
      appearance: Record<string, unknown>;
      background?: Record<string, unknown>;
      effects?: Record<string, number>;
    }
  >;

  it('主项目和在线编辑器都提供两个 Standard 主题', () => {
    expect(appHtml).toContain('<option value="standard-dark">Standard Dark</option>');
    expect(appHtml).toContain('<option value="standard-light">Standard Light</option>');
    expect(editorHtml).toContain('<select id="preset-select" class="preset-select">');
    expect(editorHtml).toContain('<option value="standard-dark">Standard Dark</option>');
    expect(editorHtml).toContain('<option value="standard-light">Standard Light</option>');
    expect(editorHtml).toContain('colorScheme,');
  });

  it('用户空间和终端页都可以直接切换主题风格', () => {
    expect(appHtml.match(/data-theme-selector/g)).toHaveLength(3);
    expect(appHtml.match(/data-theme-import/g)).toHaveLength(3);
    expect(appHtml).not.toContain('data-theme-export');
    expect(appHtml).not.toContain('data-theme-delete');
    expect(appHtml).toContain('Apple · Soft');
    expect(appHtml).toContain('Gruvbox · Dense');
    expect(appHtml).toContain('CRT Amber');
    expect(appHtml).toContain('Glass · Soft');
  });

  it('Pages 保持独立，应用为登录用户同步单个自定义主题', () => {
    expect(mainSource).toContain("localStorage.setItem('cloudssh_imported_theme'");
    expect(mainSource).not.toContain('[data-theme-export]');
    expect(mainSource).not.toContain('[data-theme-delete]');
    expect(mainSource).toContain("fetch('/api/user/theme'");
    expect(mainSource).toContain("method: 'PUT'");
    expect(mainSource).toContain(
      'void restoreCloudTheme(initialThemeSelection, themeSelectionRevision)'
    );
    // glacier 已被 Apple 取代：旧选择在恢复时迁移到 Standard Dark，避免静默回退到默认主题
    expect(mainSource).toContain("selection === 'glacier'");
    expect(mainSource).toContain("'standard-dark'");
    expect(workerSource).toContain("url.pathname === '/api/user/theme'");
    expect(userDbSource).toContain('CREATE TABLE IF NOT EXISTS user_themes');
    expect(userDbSource).not.toContain('handleDeleteTheme');
    expect(editorHtml).not.toContain('/api/user/theme');
  });

  it('样式表使用语义令牌实现外观与布局解耦', () => {
    for (const token of [
      '--control-radius',
      '--card-radius',
      '--space-scale',
      '--font-ui',
      '--shadow-card',
      '--motion-normal',
      '--terminal-frame-gap',
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
    for (const themeName of [
      'standard-dark',
      'standard-light',
      'cyberpunk',
      'apple',
      'gruvbox',
      'crt',
      'glass',
    ]) {
      expect(editorHtml).toContain(`<option value="${themeName}"`);
    }
    expect(editorHtml).toContain(
      "document.getElementById('preset-select').addEventListener('change'"
    );
    expect(editorHtml).toContain("syncThemeSelectors('custom')");
    expect(editorHtml).not.toContain('class="preset-chip"');
  });

  it('在线编辑器与主项目的 Standard UI 预设保持一致', () => {
    for (const themeName of ['standard-dark', 'standard-light'] as const) {
      for (const [property, value] of Object.entries(UI_THEMES[themeName])) {
        expect(editorPresets[themeName].ui[property]).toBe(value);
      }
    }
  });

  it('在线编辑器覆盖 Theme V2 全部外观和组件维度，并导出版本化 JSON', () => {
    for (const field of ['style', 'shape', 'density', 'font', 'shadow', 'motion']) {
      expect(editorHtml).toContain(`key: '${field}'`);
    }
    for (const field of ['button', 'input', 'card', 'tabs']) {
      expect(editorHtml).toContain(`key: '${field}'`);
    }
    expect(editorHtml).toContain('schemaVersion: 3');
    expect(editorHtml).toContain('baseTheme: activePreset');
    expect(editorHtml).toContain('sanitizeAppearance(data.appearance)');
    expect(editorHtml).toContain('file.size > THEME_MAX_BYTES');
    expect(editorHtml).toContain('const isValid = isSafeColor(val)');
    expect(editorHtml).toContain("e.target.setAttribute('aria-invalid', String(!isValid))");
    expect(editorHtml).toContain('invalidColorProperties.size > 0');
    expect(editorHtml).toContain('ui: safeUiTheme');
    expect(editorHtml).not.toContain('transition: all');
    expect(THEME_MAX_BYTES).toBe(64 * 1024);
    expect(editorPresets.apple.appearance).toMatchObject({
      style: 'soft',
      shape: 'soft',
      density: 'comfortable',
    });
    expect(editorPresets.crt.background).toMatchObject({ type: 'radial' });
    expect(editorPresets.glass.background).toMatchObject({ type: 'mesh', animation: 'drift' });
    expect(editorPresets.glass.appearance).toMatchObject({ blur: 'strong' });
  });

  it('终端订阅全局主题并在销毁时解除订阅', () => {
    expect(terminalSource).toContain('onTerminalThemeChange((theme)');
    expect(terminalSource).toContain('this.themeCleanup()');
  });
});

describe('Theme V3 背景层、效果与版式', () => {
  afterEach(() => applyBuiltInTheme('cyberpunk'));

  it('四种背景类型合成安全 CSS 渐变串，缺省/纯色回退基色', () => {
    expect(resolveBackgroundCss(undefined)).toBe('var(--bg)');
    expect(
      resolveBackgroundCss({ type: 'solid', stops: ['#0a0a0a'], angle: 0, scrim: 0, animation: 'none' })
    ).toBe('var(--bg)');
    expect(
      resolveBackgroundCss({
        type: 'linear',
        stops: ['#0a0a0a', '#11170c'],
        angle: 165,
        scrim: 0.3,
        animation: 'none',
      })
    ).toBe('linear-gradient(165deg, #0a0a0a, #11170c)');
    expect(
      resolveBackgroundCss({
        type: 'radial',
        stops: ['#261b00', '#0f0a00'],
        angle: 160,
        scrim: 0.3,
        animation: 'none',
      })
    ).toContain('radial-gradient(ellipse at 50% 25%, #261b00, #0f0a00)');
    expect(
      resolveBackgroundCss({
        type: 'mesh',
        stops: ['#d3e3f8', '#e8edf5', '#ece0f6'],
        angle: 135,
        scrim: 0.35,
        animation: 'drift',
      })
    ).toMatch(/^radial-gradient\(at 18% 22%, #d3e3f8 0px, transparent 55%\), radial-gradient/);
  });

  it('背景停靠点过白名单并截断到 5 个，渐变强制读性遮罩下限', () => {
    const normalized = normalizeImportedTheme({
      background: {
        type: 'linear',
        stops: ['#0a0a0a', '#11170c', '#1a2410', '#223018', '#2a3a20', '#324428'],
        angle: 999,
        scrim: -1,
        animation: 'invalid',
      },
    });
    expect(normalized?.background?.stops).toHaveLength(5);
    expect(normalized?.background?.angle).toBe(360);
    expect(normalized?.background?.scrim).toBeGreaterThanOrEqual(0.25);
    expect(normalized?.background?.animation).toBe('none');

    const light = normalizeImportedTheme({
      colorScheme: 'light',
      background: { type: 'mesh', stops: ['#d3e3f8', '#e8edf5'], angle: 135, scrim: 0, animation: 'none' },
    });
    expect(light?.background?.scrim).toBeGreaterThanOrEqual(0.35);

    const unsafe = normalizeImportedTheme({
      background: {
        type: 'linear',
        stops: ['url(https://tracker.example/x.png)'],
        angle: 160,
        scrim: 0.3,
        animation: 'none',
      },
    });
    expect(unsafe?.background).toBeUndefined();
  });

  it('效果强度钩制在 0-1 且零值不导出，版式缩放钩制到安全区间', () => {
    const normalized = normalizeImportedTheme({
      effects: { scanline: 5, flicker: -1, glow: 0.4, noise: 0 },
      typography: { fontScale: 99, radiusScale: 0.01 },
    });
    expect(normalized?.effects).toEqual({ scanline: 1, glow: 0.4 });
    expect(normalized?.typography).toEqual({ fontScale: 1.25, radiusScale: 0.5 });
    expect(normalizeImportedTheme({ effects: { glow: 0 } })).toBeNull();
  });

  it('内置主题携带差异化的背景、效果与版式配置', () => {
    expect(BUILT_IN_BACKGROUND.crt?.type).toBe('radial');
    expect(BUILT_IN_BACKGROUND.glass?.type).toBe('mesh');
    expect(BUILT_IN_BACKGROUND.glass?.animation).toBe('drift');
    expect(BUILT_IN_EFFECTS.cyberpunk).toEqual({ scanline: 1, flicker: 1 });
    expect(BUILT_IN_EFFECTS.crt?.glow).toBeGreaterThan(0);
    expect(BUILT_IN_TYPOGRAPHY.glass?.radiusScale).toBeGreaterThan(1);
    expect(BUILT_IN_BACKGROUND['standard-dark']).toBeUndefined();
  });
});
