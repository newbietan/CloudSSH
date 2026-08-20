import type { Page } from '@playwright/test';

export async function blockOptionalThirdPartyAssets(page: Page): Promise<void> {
  await page.route(
    /https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|challenges\.cloudflare\.com)\/.*/,
    (route) => route.abort()
  );
}

export async function mockAnonymousSession(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: false,
        sitekey: '',
        githubAuthEnabled: false,
        githubAuthRequired: false,
      }),
    })
  );
}
