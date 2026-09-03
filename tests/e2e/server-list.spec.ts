import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

const servers = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1,
  user_id: 1,
  name: `Server ${String(index + 1).padStart(2, '0')}`,
  host: index === 0 ? '203.0.113.42' : `host-${index + 1}.example.com`,
  port: 22,
  username: 'deploy',
  auth_method: 'publickey',
  region: null,
  inferred_hint: 'apac',
  os: index === 0 ? 'ubuntu' : null,
  tags: index === 2 ? [] : index % 2 === 0 ? ['production', 'apac'] : ['staging'],
  created_at: '',
  updated_at: '',
}));

test.beforeEach(async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servers) })
  );
});

test('paginates after filtering and resets to the first page', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.server-card')).toHaveCount(9);
  await expect(page.locator('#server-page-info')).toContainText('30');

  await page.locator('#server-page-next').click();
  await expect(page.locator('.server-card')).toHaveCount(9);
  await expect(page.locator('#server-page-info')).toContainText('2');

  await page.locator('#server-tag-filter').selectOption('production');
  await expect(page.locator('.server-card')).toHaveCount(9);
  await expect(page.locator('#server-pagination')).toBeVisible();

  await page.locator('#server-search').fill('Server 01');
  await expect(page.locator('.server-card')).toHaveCount(1);
  await expect(page.locator('.server-card')).toContainText('#production');
});

test('有无标签的同排服务器卡片将操作按钮对齐到底部', async ({ page }) => {
  await page.goto('/');

  const visibleCards = page.locator('.server-card').filter({ visible: true });
  await expect(visibleCards).toHaveCount(9);

  const positions = await page
    .locator('.server-card:nth-child(-n+3) .server-card-actions')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        };
      })
    );

  expect(new Set(positions.map(({ top }) => top)).size).toBe(1);
  expect(new Set(positions.map(({ bottom }) => bottom)).size).toBe(1);
});

test('IP 掩码按钮支持键盘复制完整地址', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copiedServerIP = text;
        },
      },
    });
  });
  await page.goto('/?lang=zh-CN');

  const badge = page.locator('#host-badge-1');
  await expect(badge).toHaveJSProperty('tagName', 'BUTTON');
  await expect(badge).toHaveText('203.0.*.*:22');
  await badge.focus();
  await page.keyboard.press('Enter');

  await expect
    .poll(() => page.evaluate(() => (window as any).__copiedServerIP))
    .toBe('203.0.113.42');
  await expect(page.locator('.app-toast')).toContainText('已复制服务器 IP');
});

test('已识别服务器显示系统图标，未识别服务器保留默认图标', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  const firstCard = page.locator('.server-card').nth(0);
  await expect(firstCard.locator('.server-os-icon')).toHaveAttribute('title', 'Ubuntu');
  await expect(firstCard.locator('.server-os-icon svg')).toHaveAttribute('aria-label', 'Ubuntu');

  const secondCard = page.locator('.server-card').nth(1);
  await expect(secondCard.locator('.server-os-icon')).toHaveCount(0);
  await expect(secondCard.locator('.material-symbols-outlined').first()).toHaveText('dns');
});

test('展示多级跳转路径并在编辑时排除自身跳板', async ({ page }) => {
  await page.unroute('**/api/servers');
  const jumpServers = servers.map((server) => ({
    ...server,
    jump_server_id: server.id === 2 ? 1 : server.id === 3 ? 2 : null,
  }));
  await page.route('**/api/servers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(jumpServers),
    })
  );
  await page.goto('/?lang=zh-CN');

  await expect(page.locator('#card-3')).toContainText('Server 01 → Server 02');
  await expect(page.locator('#card-3')).toContainText('由跳板入口决定');
  await expect(page.locator('#card-3')).toContainText('随跳板');
  await page.locator('#edit-3').click();
  const jumpSelect = page.locator('#server-jump-host');
  const regionSelect = page.locator('#server-region');
  await expect(jumpSelect).toHaveValue('2');
  await expect(jumpSelect.locator('option[value="3"]')).toHaveCount(0);
  await expect(jumpSelect.locator('option[value="2"]')).toHaveText('Server 02');
  await expect(regionSelect).toBeDisabled();
  await expect(page.locator('#server-region-inferred')).toContainText('不会查询当前内网主机');

  await jumpSelect.selectOption('');
  await expect(regionSelect).toBeEnabled();
  await expect(regionSelect).toHaveValue('');
});

test('点击克隆服务器按钮打开预填表单并附带复制后缀', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  const cloneBtn = page.locator('#clone-1');
  await expect(cloneBtn).toBeVisible();
  await cloneBtn.click();

  const modal = page.locator('#server-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#modal-title')).toContainText('克隆服务器');
  await expect(page.locator('#server-name')).toHaveValue('Server 01 (复制)');
  await expect(page.locator('#server-host')).toHaveValue('203.0.113.42');
  await expect(page.locator('#server-port')).toHaveValue('22');
  await expect(page.locator('#server-username')).toHaveValue('deploy');
});
