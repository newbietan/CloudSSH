import { expect, test } from '@playwright/test';

test('分享凭证立即离开地址栏，并且只在接收者明确确认后领取', async ({ page }) => {
  const token = 'a'.repeat(43);
  let claimCount = 0;
  await page.route('**/api/share/claim', async (route) => {
    claimCount++;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'This share link has already been used' }),
    });
  });

  await page.goto(`/#/share/${token}`);

  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.locator('#share-claim-btn')).toBeVisible();
  expect(claimCount).toBe(0);

  await page.locator('#share-claim-btn').click();

  // 断言本地化后的错误文案（en/zh 双语兼容），不耦合具体措辞
  await expect(page.locator('#share-claim-error')).toContainText(/claimed or revoked|已被领取或已撤销/);
  expect(claimCount).toBe(1);
  expect(page.url()).not.toContain(token);
});
