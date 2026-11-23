import { readFileSync } from 'node:fs';
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
  const switcherWidth = (await modal.locator('#server-kind-switch').boundingBox())!.width;
  const fieldsWidth = (await modal.locator('.server-modal-fields').boundingBox())!.width;
  expect(switcherWidth / fieldsWidth).toBeGreaterThan(0.97);
  expect((await linux.boundingBox())!.width).toBeCloseTo((await windows.boundingBox())!.width, 0);
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
  await expect(modal.getByText('On your first connection, check and confirm the Windows certificate.')).toBeVisible();
  await expect(modal.getByLabel(/fingerprint/i)).toHaveCount(0);
  await modal.locator('#server-submit-btn').click();
  const card = page.locator(`#server-grid #rdp-card-${id}`);
  const connection = card.getByRole('link', { name: 'Open desktop' });
  await expect(connection).toHaveAttribute('href', `/rdp/${id}`);
  await expect(connection).toHaveAttribute('rel', 'noopener');
  expect(saved).toEqual({ name: 'Windows workstation', route: 'direct', host: '93.184.215.14' });
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

for (const scenario of ['accept', 'cancel', 'saved match', 'saved mismatch', 'save failed'] as const) {
  test(`Windows certificate: ${scenario}`, async ({ page }) => {
    const fingerprint = 'ab'.repeat(32);
    const other = 'cd'.repeat(32);
    const saved = scenario === 'saved match' ? fingerprint : scenario === 'saved mismatch' ? other : null;
    const path = `/api/rdp/profiles/${id}`;
    let attempts = 0;
    const asset = (name: string) => readFileSync(`${__dirname}/../../src/worker/rdp-client/${name}.rdp-text`, 'utf8');
    await page.route(`**/rdp/${id}`, route => route.fulfill({
      contentType: 'text/html', body: asset('index'),
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    }));
    await page.route('**/rdp/assets/desktop.js', route => route.fulfill({ contentType: 'text/javascript', body: asset('desktop') }));
    await page.route('**/rdp/assets/rdp-socket.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.createCloudSshRdpSocket = () => ({ lease: '${id}', close() { this.lease = undefined; } });
    ` }));
    await page.route('**/rdp/assets/sdl-freerdp.wasm', route => route.fulfill({
      contentType: 'application/wasm', body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    }));
    await page.route('**/rdp/assets/sdl-freerdp.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      const m = window.Module;
      window.certificateResult = 'not checked';
      m.callMain = () => {
        m.createRdpSocket(m.websocket.url);
        window.certificateResult = m.onWindowsCertificate('${fingerprint}');
      };
      m.onRuntimeInitialized();
    ` }));
    await page.route(`**${path}`, route => route.request().method() === 'GET'
      ? route.fulfill({ json: { id, name: 'Windows workstation', revision: 1, fingerprint: saved } }) : route.fallback());
    await page.route(`**${path}/connect`, route => route.request().method() === 'POST'
      ? route.fulfill({ json: { ticket: '1'.repeat(64), revision: 1 } }) : route.fallback());
    await page.route(`**${path}/trust`, route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      attempts++;
      expect(route.request().postDataJSON()).toEqual({ fingerprint, lease: id, revision: 1 });
      return route.fulfill({ status: scenario === 'save failed' ? 409 : 200, json: { fingerprint } });
    });
    await page.addInitScript(() => {
      localStorage.setItem('cloudssh_locale', 'en-US');
      // WebKit does not expose isolation for intercepted HTML; the mock never uses pthreads.
      if (!crossOriginIsolated) Object.defineProperty(window, 'crossOriginIsolated', { value: true });
      if (typeof SharedArrayBuffer !== 'function') Object.defineProperty(window, 'SharedArrayBuffer', { value: ArrayBuffer });
    });
    test.setTimeout(12_000);
    await page.goto(`/rdp/${id}`);
    await page.locator('#windows-user').fill('user');
    await page.locator('#windows-password').fill('test only');
    await page.locator('#connect').click();
    const result = () => page.evaluate(() => Reflect.get(window, 'certificateResult'));
    const decision = () => page.evaluate(() => Reflect.get(window, 'Module').onWindowsCertificate(null));
    const dialog = page.locator('#certificate');
    if (scenario === 'saved match') {
      await expect.poll(result).toBe(1);
      await expect(dialog).toBeHidden();
    } else {
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#certificate-fingerprint')).toHaveText(Array(32).fill('AB').join(':'));
      if (scenario === 'saved mismatch') {
        await expect.poll(result).toBe(-1);
        await expect(dialog.locator('#certificate-saved')).toHaveText(Array(32).fill('CD').join(':'));
        await expect(dialog.getByRole('button', { name: 'Trust and connect' })).toBeHidden();
      } else {
        await expect.poll(decision).toBe(0);
        expect(attempts).toBe(0);
        if (scenario === 'cancel') await page.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: 'Trust and connect' }).click();
        await expect(dialog).toBeHidden();
        await expect.poll(decision).toBe(scenario === 'accept' ? 1 : -1);
      }
    }
    expect(attempts).toBe(scenario === 'accept' || scenario === 'save failed' ? 1 : 0);
  });
}
