import type { Page } from '@playwright/test';

export const OPTIONAL_THIRD_PARTY_ASSETS =
  /https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|challenges\.cloudflare\.com)\/.*/;

export async function blockOptionalThirdPartyAssets(page: Page): Promise<void> {
  await page.route(OPTIONAL_THIRD_PARTY_ASSETS, (route) => route.abort());
}

/** Enter the same disclosures an owner uses before editing a grant on desktop or mobile. */
export async function revealMcpGrant(page: Page, id: number): Promise<void> {
  const closed = page.locator('#mcp-permissions:not([open]) > summary');
  if (await closed.isVisible()) await closed.click();
  const row = page.locator(`#mcp-permissions [data-grant-id="${id}"]`);
  await row.waitFor({ state: 'visible' });
  const heading = row.locator(':scope:not([open]) > summary');
  if (await heading.isVisible()) await heading.click();
}

// Base API reads are installed automatically by fixtures.ts, independently of these helpers.
export async function mockAnonymousSession(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
}
