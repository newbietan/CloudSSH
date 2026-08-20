import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test('anonymous connection form has no serious accessibility violations', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/');
  await expect(page.locator('#connection-form')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious'
    )
  ).toEqual([]);
});

test('private key textarea keeps Enter as a newline instead of submitting the form', async ({
  page,
}) => {
  await mockAnonymousSession(page);
  await page.goto('/');

  await page.locator('#host').fill('example.com');
  await page.locator('#username').fill('deploy');
  await page.locator('#auth-tab-key').click();
  const privateKey = page.locator('#private-key');
  await privateKey.fill('line one');
  await privateKey.press('Enter');
  await privateKey.type('line two');

  await expect(privateKey).toHaveValue('line one\nline two');
  await expect(page.locator('#auth-section')).toBeVisible();
  await expect(page.locator('#terminal-section')).toBeHidden();
});

test('server modal exposes keyboard-operable dialog semantics', async ({ page }) => {
  await mockAnonymousSession(page);
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
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );

  await page.goto('/');
  await page.locator('#empty-add-btn').click();
  const modal = page.locator('#server-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#server-name')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});
