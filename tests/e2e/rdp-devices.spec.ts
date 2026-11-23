import { expect, test } from './fixtures';

const id = '12345678-1234-1234-1234-123456789abc';

test('a signed-in user can save and remove an RDP-only device', async ({ page }) => {
  await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github', rdpEnabled: true,
  } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback());
  let profiles: Record<string, unknown>[] = [];
  let saved: Record<string, unknown> | undefined;
  await page.route('**/api/rdp/profiles', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { profiles } });
    if (route.request().method() === 'POST') {
      saved = route.request().postDataJSON() as Record<string, unknown>;
      profiles = [{ ...saved, id, revision: 1, hasAccessToken: false }];
      return route.fulfill({ status: 201, json: profiles[0] });
    }
    return route.fallback();
  });
  await page.route(`**/api/rdp/profiles/${id}`, route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    profiles = [];
    return route.fulfill({ json: { success: true } });
  });
  await page.goto('/?lang=en-US');
  await page.getByRole('button', { name: 'Add remote desktop' }).click();
  await page.getByLabel('Device name').fill('Workstation');
  await page.getByLabel('IPv4 address or tunnel hostname').fill('93.184.215.14');
  await page.getByLabel('Windows certificate SHA-256 fingerprint').fill('1'.repeat(64));
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  const connection = page.getByRole('link', { name: 'Open desktop' });
  await expect(connection).toHaveAttribute('href', `/rdp/${id}`);
  await expect(connection).toHaveAttribute('rel', 'noopener');
  expect(saved).toEqual({ name: 'Workstation', route: 'direct', host: '93.184.215.14', fingerprint: '1'.repeat(64) });
  await page.getByRole('button', { name: 'Delete device' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete device' }).click();
  await expect(connection).toHaveCount(0);
});
