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
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' }),
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
