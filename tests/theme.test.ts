import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  THEMES,
  UI_THEMES,
  applyBuiltInTheme,
  applyImportedTheme,
  getActiveTerminalTheme,
  isBuiltInTheme,
  onTerminalThemeChange,
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

  it('旧版浅色自定义主题可以推断模式并继承浅色 ANSI 配色', () => {
    applyImportedTheme({
      ui: {
        '--bg': '#ffffff',
        '--text': '#202124',
      },
    });

    expect(getActiveTerminalTheme().background).toBe(THEMES['standard-light'].background);
    expect(getActiveTerminalTheme().yellow).toBe(THEMES['standard-light'].yellow);
  });
});

describe('Standard 主题入口和编辑器', () => {
  const appHtml = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const editorHtml = readFileSync(new URL('../docs/theme-editor/index.html', import.meta.url), 'utf8');
  const terminalSource = readFileSync(new URL('../frontend/src/terminal.ts', import.meta.url), 'utf8');

  it('主项目和在线编辑器都提供两个 Standard 主题', () => {
    expect(appHtml).toContain('<option value="standard-dark">Standard Dark</option>');
    expect(appHtml).toContain('<option value="standard-light">Standard Light</option>');
    expect(editorHtml).toContain('<select id="preset-select" class="preset-select">');
    expect(editorHtml).toContain('<option value="standard-dark">Standard Dark</option>');
    expect(editorHtml).toContain('<option value="standard-light">Standard Light</option>');
    expect(editorHtml).toContain("colorScheme: preset?.colorScheme || colorScheme");
  });

  it('在线编辑器通过下拉框完整展示和切换全部预设', () => {
    for (const themeName of ['standard-dark', 'standard-light', 'cyberpunk', 'glacier', 'gruvbox']) {
      expect(editorHtml).toContain(`<option value="${themeName}"`);
    }
    expect(editorHtml).toContain("document.getElementById('preset-select').addEventListener('change'");
    expect(editorHtml).toContain("document.getElementById('preset-select').value = 'custom'");
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
