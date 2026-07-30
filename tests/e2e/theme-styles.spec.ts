import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

const server = {
  id: 1,
  user_id: 1,
  name: 'Theme Preview',
  host: 'preview.example.com',
  port: 22,
  username: 'tester',
  auth_method: 'publickey',
  region: null,
  inferred_hint: 'apac',
  tags: ['preview'],
  created_at: '',
  updated_at: '',
};

test.beforeEach(async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: route.request().method() === 'GET' ? '{"theme":null}' : '{"success":true}',
    }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    }),
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([server]) }),
  );
});

test('内置主题切换 UI 风格但保持服务器列表结构稳定', async ({ page }) => {
  await page.goto('/');

  const selector = page.locator('#user-theme-selector');
  const terminalSelector = page.locator('#theme-selector');
  const card = page.locator('.server-card');
  const grid = page.locator('#server-grid');

  await expect(selector).toBeVisible();
  await expect(card).toHaveCount(1);
  await expect(grid).toHaveClass(/grid-cols-1/);

  await selector.selectOption('glacier');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'soft');
  await expect(page.locator('html')).toHaveAttribute('data-component-card', 'elevated');
  await expect(card).toHaveCSS('border-radius', '15px');
  await expect(terminalSelector).toHaveValue('glacier');

  await selector.selectOption('gruvbox');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'dense');
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'compact');
  await expect(card).toHaveCSS('border-radius', '9px');
  await expect(card).toHaveCSS('box-shadow', 'none');

  await selector.selectOption('cyberpunk');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'cyberpunk');
  await expect(card).toHaveCSS('border-radius', '0px');
  await expect(grid).toHaveClass(/md:grid-cols-2/);
  await expect(grid).toHaveClass(/lg:grid-cols-3/);
});

test('终端四周留白按形状收窄并为圆角保留安全间距', async ({ page }) => {
  const wsUrl = encodeURIComponent('ws://127.0.0.1:4173/fake');
  await page.goto(`/?wsUrl=${wsUrl}&name=ThemePreview&host=127.0.0.1&port=22`);

  const selector = page.locator('#theme-selector');
  const terminalMain = page.locator('.terminal-main');
  const terminalWrapper = page.locator('#terminal-wrapper');

  await selector.selectOption('cyberpunk');
  await expect(terminalMain).toHaveCSS('padding', '4px');
  await expect(terminalWrapper).toHaveCSS('border-radius', '0px');

  await selector.selectOption('standard-dark');
  await expect(terminalMain).toHaveCSS('padding', '7px');
  await expect(terminalWrapper).toHaveCSS('border-radius', '9px');

  await selector.selectOption('glacier');
  await expect(terminalMain).toHaveCSS('padding', '10px');
  await expect(terminalWrapper).toHaveCSS('border-radius', '15px');
});

test('应用可导入、导出并在本地删除 Theme V2 JSON', async ({ page }) => {
  const themeRequestMethods: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/user/theme')) {
      themeRequestMethods.push(request.method());
    }
  });
  await page.goto('/');

  const customTheme = {
    schemaVersion: 2,
    name: 'Ocean Soft',
    baseTheme: 'glacier',
    colorScheme: 'dark',
    ui: {
      '--accent': '#22d3ee',
      '--bg': '#071827',
    },
    appearance: {
      style: 'soft',
      shape: 'soft',
      density: 'spacious',
      components: {
        button: 'soft',
        input: 'boxed',
        card: 'elevated',
        tabs: 'segmented',
      },
    },
  };

  await page.locator('#import-theme-input').setInputFiles({
    name: 'ocean-soft.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(customTheme)),
  });

  await expect(page.locator('#user-theme-selector')).toHaveValue('__custom__');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'soft');
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'spacious');
  await expect(page.locator('[data-theme-export]').first()).toBeVisible();
  await expect(page.locator('[data-theme-delete]').first()).toBeVisible();
  await expect.poll(() => themeRequestMethods).toContain('PUT');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-theme-export]').first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('cloudssh-theme-ocean-soft.json');

  await page.locator('[data-theme-delete]').first().click();
  await page.locator('.app-dialog__button--confirm').click();

  await expect(page.locator('#user-theme-selector')).toHaveValue('cyberpunk');
  await expect(page.locator('[data-theme-export]').first()).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cloudssh_imported_theme'))).toBeNull();
  expect(themeRequestMethods).toEqual(expect.arrayContaining(['GET', 'PUT', 'DELETE']));
});

test('新浏览器登录后自动恢复并启用账号中的自定义主题', async ({ page }) => {
  await page.unroute('**/api/user/theme');
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        theme: {
          schemaVersion: 2,
          name: 'Synced Glacier',
          baseTheme: 'glacier',
          colorScheme: 'dark',
          ui: { '--accent': '#67e8f9' },
          appearance: {
            style: 'soft',
            shape: 'soft',
            density: 'comfortable',
            components: { card: 'elevated' },
          },
        },
      }),
    }),
  );

  await page.goto('/');

  await expect(page.locator('#user-theme-selector')).toHaveValue('__custom__');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'soft');
  await expect(page.locator('html')).toHaveAttribute('data-component-card', 'elevated');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cloudssh_theme_selection')))
    .toBe('__custom__');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cloudssh_imported_theme')))
    .toContain('Synced Glacier');
});
