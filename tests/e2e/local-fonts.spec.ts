import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HTML } from '../../src/worker/html';
import { test, expect, type Page } from './fixtures';

const root = path.resolve(__dirname, '../..');
const { icons } = JSON.parse(
  readFileSync(path.join(root, 'frontend/src/assets/fonts/material-symbols.json'), 'utf8')
) as { icons: string[] };

const editorAssets = new Map([
  ['index.html', 'text/html'],
  ['favicon.svg', 'image/svg+xml'],
  ['fonts/fonts.css', 'text/css'],
  ['fonts/material-symbols-outlined-subset.woff2', 'font/woff2'],
  ['fonts/jetbrains-mono.woff2', 'font/woff2'],
]);

async function openFontPage(page: Page, source: 'development' | 'worker' | 'theme-editor') {
  if (source === 'worker') {
    // Serve the actual generated Worker payload, not Vite's transformed source page.
    // Initialization APIs still go through the shared method-specific fixture guard.
    await page.route((url) => url.pathname === '/', (route) =>
      route.fulfill({ contentType: 'text/html', body: HTML })
    );
  }
  if (source === 'theme-editor') {
    // Model the Pages directory with its real relative URLs and committed asset bytes.
    await page.route('**/theme-editor/**', async (route) => {
      const asset = new URL(route.request().url()).pathname.slice('/theme-editor/'.length);
      const contentType = editorAssets.get(asset);
      expect(contentType, `Unexpected editor asset: ${asset}`).toBeDefined();
      await route.fulfill({
        contentType,
        body: readFileSync(path.join(root, 'docs/theme-editor', asset)),
      });
    });
  }
  await page.goto(source === 'theme-editor' ? '/theme-editor/index.html' : '/');
}

async function checkFontRendering(page: Page) {
  const metrics = await page.evaluate(async (names) => {
    const loadCounts = await Promise.all([
      ...[100, 400, 700].map(async (weight) =>
        (await document.fonts.load(`${weight} 24px "Material Symbols Outlined"`)).length
      ),
      ...[400, 600, 700].map(async (weight) =>
        (await document.fonts.load(`${weight} 14px "JetBrains Mono"`)).length
      ),
    ]);
    await document.fonts.ready;
    const context = document.createElement('canvas').getContext('2d')!;
    const missing: string[] = [];
    for (const weight of [100, 400, 700]) {
      context.font = `${weight} 24px "Material Symbols Outlined"`;
      for (const name of names) {
        if (Math.abs(context.measureText(name).width - 24) > 0.1) {
          missing.push(`${weight}:${name}`);
        }
      }
    }
    return { loadCounts, missing };
  }, icons);
  expect(metrics.loadCounts).toEqual([1, 1, 1, 1, 1, 1]);
  expect(metrics.missing, 'Every icon must shape into one glyph at each supported weight').toEqual([]);
  const family = await page.locator('.material-symbols-outlined').first().evaluate(
    (element) => getComputedStyle(element).fontFamily.replace(/^(['"])(.*)\1$/, '$2')
  );
  expect(family).toBe('Material Symbols Outlined');

  await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.id = 'local-font-variation-probe';
    probe.className = 'material-symbols-outlined';
    probe.setAttribute('aria-hidden', 'true');
    probe.textContent = 'lock';
    probe.style.cssText = `all: initial; display: block; position: fixed; left: 0; top: 0;
      width: 32px; height: 32px; z-index: 99999; overflow: hidden;
      font: 32px/1 "Material Symbols Outlined"; color: white; background: black;`;
    document.body.appendChild(probe);
  });
  const probe = page.locator('#local-font-variation-probe');
  const glyphs: Buffer[] = [];
  for (const settings of [
    '"FILL" 0, "wght" 400',
    '"FILL" 1, "wght" 400',
    '"FILL" 0, "wght" 100',
    '"FILL" 0, "wght" 700',
  ]) {
    await probe.evaluate((element, value) => { element.style.fontVariationSettings = value; }, settings);
    glyphs.push(await probe.screenshot({ animations: 'disabled', scale: 'css' }));
  }
  expect(glyphs[0], 'FILL must change the actual icon outline').not.toEqual(glyphs[1]);
  expect(glyphs[2], 'wght must change the actual icon outline').not.toEqual(glyphs[3]);
  await probe.evaluate((element) => element.remove());
}

for (const source of ['development', 'worker', 'theme-editor'] as const) {
  test(`${source} renders local fonts, ligatures and variable axes without Google Fonts`, async ({ page }) => {
    const remoteFonts: string[] = [];
    const fontRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (/fonts\.(?:googleapis|gstatic)\.com/.test(request.url())) remoteFonts.push(request.url());
      if (request.resourceType() === 'font' && !request.url().startsWith('data:')) {
        fontRequests.push(new URL(request.url()).pathname);
      }
    });
    await openFontPage(page, source);
    await checkFontRendering(page);
    expect(remoteFonts).toEqual([]);
    expect(pageErrors).toEqual([]);
    if (source === 'worker') expect(fontRequests, 'Worker fonts must not need asset routes').toEqual([]);
    if (source === 'theme-editor') {
      expect(fontRequests.sort()).toEqual([
        '/theme-editor/fonts/jetbrains-mono.woff2',
        '/theme-editor/fonts/material-symbols-outlined-subset.woff2',
      ]);
    }
  });
}
