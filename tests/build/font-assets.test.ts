import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fontsDir = path.join(root, 'frontend/src/assets/fonts');
const { assertInlinedFonts, LOCAL_FONT_FILES } = createRequire(import.meta.url)(
  '../../scripts/font-assets.js'
) as {
  assertInlinedFonts: (css: string, assetNames: string[], fontsDir: string) => void;
  LOCAL_FONT_FILES: string[];
};
const fontFaces = LOCAL_FONT_FILES.map((filename) => {
  const data = readFileSync(path.join(fontsDir, filename)).toString('base64');
  return `@font-face{font-family:"${filename}";src:url("data:font/woff2;base64,${data}")}`;
});
const css = fontFaces.join('\n');
const assets = ['index.js', 'index.css'];

describe('single-HTML Worker font build guard', () => {
  it('accepts the two complete, inlined font files', () => {
    expect(() => assertInlinedFonts(css, assets, fontsDir)).not.toThrow();
  });

  it.each(LOCAL_FONT_FILES.map((filename, index) => ({ filename, index })))(
    'rejects missing or incomplete $filename',
    ({ index }) => {
      const missing = fontFaces.filter((_, i) => i !== index).join('\n');
      expect(() => assertInlinedFonts(missing, assets, fontsDir)).toThrow('not inlined completely');
    }
  );

  it('rejects standalone fonts even when inline copies also exist', () => {
    expect(() => assertInlinedFonts(css, [...assets, 'font.woff2'], fontsDir)).toThrow(
      'standalone font assets'
    );
  });

  it.each(['url(/font.woff2)', 'url("https://example.com/font.woff2")'])(
    'rejects an external font-face fallback: %s',
    (url) => {
      expect(() => assertInlinedFonts(`${css}\n@font-face{src:${url}}`, assets, fontsDir)).toThrow(
        'font-face URLs'
      );
    }
  );

  it('rejects a remote Google Fonts stylesheet', () => {
    expect(() => assertInlinedFonts(`${css}\n@import url(https://fonts.googleapis.com/css2);`, assets, fontsDir))
      .toThrow('Google Fonts');
  });
});
