import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

const servers = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  user_id: 1,
  name: index === 0
    ? '这是一台名称很长但不应撑破移动端卡片的生产服务器'
    : `移动端服务器 ${index + 1}`,
  host: index === 0
    ? 'a-very-long-host-name-that-must-not-overflow.example.com'
    : `server-${index + 1}.example.com`,
  port: 22,
  username: index === 0 ? 'long-mobile-deployment-username' : 'deploy',
  auth_method: 'publickey',
  region: null,
  inferred_hint: 'apac',
  tags: index === 0 ? ['production', 'database'] : [],
  created_at: '',
  updated_at: '',
}));

test.use({ viewport: { width: 320, height: 568 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 1,
        github_id: 1,
        username: 'mobile-layout-tester-with-a-long-name',
        avatar_url: '',
      }),
    }),
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servers) }),
  );
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"configured":false}' }),
  );
});

test('移动端用户空间保持单行顶栏并通过菜单访问次要操作', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  await expect(page.locator('#user-space-section')).toBeVisible();
  await expect(page.locator('.server-card')).toHaveCount(3);
  await expect(page.locator('#user-space-header-actions')).toBeHidden();

  const layout = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.user-space-header')!;
    const main = document.querySelector<HTMLElement>('.user-space-main')!;
    const section = document.getElementById('user-space-section')!;
    const headerRect = header.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      headerHeight: Math.round(headerRect.height),
      headerScrollHeight: header.scrollHeight,
      mainTop: Math.round(mainRect.top),
      headerBottom: Math.round(headerRect.bottom),
      sectionHeight: Math.round(section.getBoundingClientRect().height),
      mainScrollable: main.scrollHeight > main.clientHeight,
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(layout.headerHeight).toBeLessThanOrEqual(53);
  expect(layout.headerScrollHeight).toBeLessThanOrEqual(53);
  expect(layout.mainTop).toBeGreaterThanOrEqual(layout.headerBottom);
  expect(layout.sectionHeight).toBe(568);
  expect(layout.mainScrollable).toBe(true);
  expect(layout.documentWidth).toBe(320);

  await page.locator('#user-space-more-btn').click();
  await expect(page.locator('#user-space-more-btn')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#user-space-header-actions')).toBeVisible();
  await expect(page.locator('#user-space-header-actions .language-toggle')).toBeVisible();

  await page.locator('.user-space-main').click({ position: { x: 4, y: 4 } });
  await expect(page.locator('#user-space-header-actions')).toBeHidden();
  await expect(page.locator('#user-space-more-btn')).toHaveAttribute('aria-expanded', 'false');
});

test('服务器分页在手机、触屏平板和桌面宽度间自动切换', async ({ page }) => {
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('.server-card')).toHaveCount(3);

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.locator('.server-card')).toHaveCount(6);

  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.locator('.server-card')).toHaveCount(9);
});

test('移动端服务器卡片不会被长文本撑宽且表单弹窗在视口内滚动', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  const cardLayout = await page.locator('#card-1').evaluate((card) => {
    const title = card.querySelector<HTMLElement>('.server-card-title')!;
    return {
      cardClientWidth: card.clientWidth,
      cardScrollWidth: card.scrollWidth,
      titleOverflow: getComputedStyle(title).overflow,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(cardLayout.cardScrollWidth).toBeLessThanOrEqual(cardLayout.cardClientWidth);
  expect(cardLayout.titleOverflow).toBe('hidden');
  expect(cardLayout.documentWidth).toBe(320);

  await page.locator('#add-server-btn').click();
  await expect(page.locator('#server-modal')).toBeVisible();

  const modalLayout = await page.locator('#server-modal .responsive-modal-panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const input = document.getElementById('server-name')!;
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight,
      overflowY: getComputedStyle(panel).overflowY,
      inputFontSize: getComputedStyle(input).fontSize,
    };
  });

  expect(modalLayout.top).toBeGreaterThanOrEqual(0);
  expect(modalLayout.bottom).toBeLessThanOrEqual(568);
  expect(modalLayout.scrollHeight).toBeGreaterThan(modalLayout.clientHeight);
  expect(modalLayout.overflowY).toBe('auto');
  expect(modalLayout.inputFontSize).toBe('16px');

  await page.setViewportSize({ width: 568, height: 320 });
  await expect.poll(() => page.locator('#server-modal .responsive-modal-panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })).toBe(true);

  await page.locator('#server-submit-btn').scrollIntoViewIfNeeded();
  await expect(page.locator('#server-submit-btn')).toBeVisible();
  await page.locator('#server-submit-btn').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#server-modal')).toBeHidden();
});

test('移动端 AI 设置弹窗完整位于可视区域内', async ({ page }) => {
  await page.goto('/?lang=zh-CN');
  await page.locator('#user-space-more-btn').click();
  await page.locator('#ai-config-btn').click();

  const panel = page.locator('#ai-config-modal .responsive-modal-panel');
  await expect(panel).toBeVisible();
  const layout = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      overflowY: getComputedStyle(element).overflowY,
      inputFontSize: getComputedStyle(document.getElementById('ai-base-url')!).fontSize,
    };
  });

  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(568);
  expect(layout.overflowY).toBe('auto');
  expect(layout.inputFontSize).toBe('16px');
});
