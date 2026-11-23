import { expect, test } from './fixtures';

const id = '12345678-1234-1234-1234-123456789abc';
const ssh = {
  id: 1, user_id: 1, name: 'Linux workstation', host: 'ssh.example.com', port: 22,
  username: 'deploy', auth_method: 'password', tags: [], created_at: '', updated_at: '',
};

test('Windows uses the shared add-server dialog and the main server grid', async ({ page }) => {
  await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github', rdpEnabled: true,
  } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET' ? route.fulfill({ json: [ssh] }) : route.fallback());
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
  await expect(page.locator('#server-grid')).toContainText('Linux workstation');
  await expect(page.getByRole('button', { name: 'Add remote desktop' })).toHaveCount(0);
  await page.locator('#add-server-btn').click();
  const modal = page.locator('#server-modal');
  const linux = modal.getByRole('button', { name: 'Linux', exact: true });
  const windows = modal.getByRole('button', { name: 'Windows Server' });
  await expect(linux).toHaveAttribute('aria-pressed', 'true');
  await expect(modal.locator('#server-rdp-fields')).toBeHidden();
  await modal.locator('#server-name').fill('SSH draft');
  await windows.click();
  await expect(windows).toHaveAttribute('aria-pressed', 'true');
  await expect(modal.locator('#server-ssh-fields')).toBeHidden();
  await expect(modal.locator('#server-name')).toBeDisabled();
  await modal.getByLabel('Device name').fill('Windows workstation');
  await modal.getByLabel('Connection route').selectOption('tunnel');
  const clientSecret = modal.getByLabel('Client Secret', { exact: true });
  await expect(clientSecret).toBeVisible();
  await modal.getByLabel('Connection route').selectOption('direct');
  await expect(clientSecret).toBeHidden();
  await linux.click();
  await expect(modal.locator('#server-name')).toHaveValue('SSH draft');
  await windows.click();
  await expect(modal.getByLabel('Device name')).toHaveValue('Windows workstation');
  await modal.getByLabel('IPv4 address or tunnel hostname').fill('93.184.215.14');
  await modal.getByLabel('Windows certificate SHA-256 fingerprint').fill('1'.repeat(64));
  await modal.locator('#server-submit-btn').click();
  const card = page.locator(`#server-grid #rdp-card-${id}`);
  const connection = card.getByRole('link', { name: 'Open desktop' });
  await expect(connection).toHaveAttribute('href', `/rdp/${id}`);
  await expect(connection).toHaveAttribute('rel', 'noopener');
  expect(saved).toEqual({ name: 'Windows workstation', route: 'direct', host: '93.184.215.14', fingerprint: '1'.repeat(64) });
  await card.getByRole('button', { name: 'Edit device' }).click();
  await expect(modal.getByLabel('Device name')).toHaveValue('Windows workstation');
  await expect(windows).toBeHidden();
  await modal.locator('#modal-close-btn').click();
  await page.locator('#add-server-btn').click();
  await expect(linux).toHaveAttribute('aria-pressed', 'true');
  await modal.locator('#modal-close-btn').click();
  await card.getByRole('button', { name: 'Delete device' }).click();
  await page.getByRole('dialog', { name: 'Delete device' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card).toHaveCount(0);
});
