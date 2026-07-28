import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

const servers = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1,
  user_id: 1,
  name: `Server ${String(index + 1).padStart(2, '0')}`,
  host: `host-${index + 1}.example.com`,
  port: 22,
  username: 'deploy',
  auth_method: 'publickey',
  region: null,
  inferred_hint: 'apac',
  tags: index % 2 === 0 ? ['production', 'apac'] : ['staging'],
  created_at: '',
  updated_at: '',
}));

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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servers) }),
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
