import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';

const root = path.resolve(__dirname, '../..');
const { icons } = JSON.parse(readFileSync(path.join(root, 'frontend/src/assets/fonts/material-symbols.json'), 'utf8')) as { icons: string[] };

test('renders every bundled icon without Google Fonts', async ({ page }) => {
  const remoteFonts: string[] = [];
  page.on('request', (request) => {
    if (/fonts\.(?:googleapis|gstatic)\.com/.test(request.url())) remoteFonts.push(request.url());
  });
  await page.goto('/');
  const missing = await page.evaluate(async (names) => {
    await document.fonts.load('24px "Material Symbols Outlined"');
    await document.fonts.load('14px "JetBrains Mono"');
    await document.fonts.ready;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    context.font = '24px "Material Symbols Outlined"';
    return names.filter((name) => Math.abs(context.measureText(name).width - 24) > 0.1);
  }, icons);
  expect(missing, '图标连字必须合成为一个 24px 图形，不能显示名称字符').toEqual([]);
  expect(remoteFonts).toEqual([]);
  await expect(page.locator('.material-symbols-outlined').first()).toHaveCSS('font-family', '"Material Symbols Outlined"');
});
