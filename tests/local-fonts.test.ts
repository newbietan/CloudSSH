import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonts = path.join(root, 'frontend/src/assets/fonts');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('frontend/src/assets/fonts/material-symbols.json')) as {
  sha256: string;
  icons: string[];
  catalog: string[];
};

function sources(directory: string, extensions: string[]): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sources(relative, extensions)
      : extensions.includes(path.extname(entry.name)) ? [relative] : [];
  });
}

const sourceFiles = [
  'frontend/index.html',
  ...sources('frontend/src', ['.ts']),
  ...sources('docs/theme-editor', ['.html', '.js']),
];

describe('self-hosted fonts and icon coverage', () => {
  it('covers HTML template text as well as quoted and dynamic icon names', () => {
    const catalog = new Set(manifest.catalog);
    const tokens = new Set(sourceFiles.flatMap((file) => read(file).match(/\b[a-z][a-z0-9_]{2,}\b/g) || []));
    const needed = [...tokens].filter((token) => catalog.has(token)).sort();
    expect(manifest.icons, '运行 scripts/subset-material-symbols.py 更新字体与清单').toEqual(needed);
    const staticIcons = sourceFiles.flatMap((file) => [...read(file).matchAll(
      /<span\b[^>]*material-symbols-outlined[^>]*>\s*([a-z][a-z0-9_]*)\s*<\/span>/g
    )].map((match) => match[1]));
    for (const name of staticIcons) expect(manifest.icons).toContain(name);
    for (const name of ['lock', 'share', 'history', 'arrow_back', 'shield', 'logout', 'psychology']) {
      expect(manifest.icons).toContain(name);
    }
  });

  it('keeps the generated font and its coverage manifest in sync', () => {
    const font = readFileSync(path.join(fonts, 'material-symbols-outlined-subset.woff2'));
    expect(font.subarray(0, 4).toString()).toBe('wOF2');
    expect(createHash('sha256').update(font).digest('hex')).toBe(manifest.sha256);
  });

  it('removes remote fonts from both applications and preserves their licenses', () => {
    for (const file of ['frontend/index.html', 'docs/theme-editor/index.html']) {
      expect(read(file)).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    }
    expect(read('frontend/src/style.css')).toContain("@import './assets/fonts/fonts.css'");
    expect(read('docs/theme-editor/index.html')).toContain('href="fonts/fonts.css"');
    expect(readFileSync(path.join(fonts, 'Material-Symbols-LICENSE.txt'), 'utf8')).toContain('Apache License');
    expect(readFileSync(path.join(fonts, 'JetBrains-Mono-OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE');
  });

  it('ships identical local font assets with the standalone theme editor', () => {
    for (const filename of ['fonts.css', 'material-symbols-outlined-subset.woff2', 'jetbrains-mono.woff2',
      'Material-Symbols-LICENSE.txt', 'JetBrains-Mono-OFL.txt']) {
      expect(readFileSync(path.join(root, 'docs/theme-editor/fonts', filename)))
        .toEqual(readFileSync(path.join(fonts, filename)));
    }
  });
});
