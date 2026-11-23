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
      const { login: _login, ...metadata } = saved;
      profiles = [{ ...metadata, id, revision: 1, hasAccessToken: false, hasLogin: true }];
      return route.fulfill({ status: 201, json: profiles[0] });
    }
    return route.fallback();
  });
  await page.route(`**/api/rdp/profiles/${id}/login-identity`, r => r.request().method() === 'POST' ? r.fulfill({ json: { revision: 1, username: 'custom-user', domain: 'WORK' } }) : r.fallback());
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
  await expect(modal.getByText('On your first connection, check and confirm the Windows certificate.')).toHaveCount(0);
  await modal.locator('#server-rdp-tags').fill('Office, Office, Windows');
  await expect(modal.getByLabel(/fingerprint/i)).toHaveCount(0);
  await expect(modal.locator('#server-rdp-remember')).toHaveCount(0);
  await expect(modal.locator('#server-rdp-user')).toHaveValue('Administrator');
  await modal.locator('#server-submit-btn').click();
  expect(saved).toBeUndefined();
  await modal.locator('#server-rdp-user').fill('custom-user');
  await modal.locator('#server-rdp-domain').fill('WORK');
  await modal.locator('#server-rdp-password').fill('synthetic');
  await modal.locator('#server-submit-btn').click();
  const card = page.locator(`#server-grid #rdp-card-${id}`);
  await expect(card.getByRole('button', { name: 'Open desktop' })).toBeVisible();
  expect(saved).toEqual({ name: 'Windows workstation', route: 'direct', host: '93.184.215.14', tags: ['Office', 'Windows'], login: { username: 'custom-user', domain: 'WORK', password: 'synthetic' } });
  await expect(card).toContainText('Office');
  await page.locator('#server-tag-filter').selectOption('Office');
  await expect(card).toBeVisible();
  await expect(page.locator('#server-grid')).not.toContainText('Linux workstation');
  await card.getByRole('button', { name: 'Edit device' }).click();
  await expect(modal.getByLabel('Device name')).toHaveValue('Windows workstation');
  await expect(modal.locator('#server-rdp-user')).toHaveValue('custom-user');
  await expect(modal.locator('#server-rdp-domain')).toHaveValue('WORK');
  await expect(modal.locator('#server-rdp-password')).toHaveValue('');
  await expect(modal.locator('#server-rdp-password')).not.toHaveAttribute('required');
  await modal.locator('#server-rdp-user').fill('different-user');
  await expect(modal.locator('#server-rdp-password')).toHaveAttribute('required');
  await expect(windows).toBeHidden();
  await modal.locator('#modal-close-btn').click();
  await page.locator('#add-server-btn').click();
  await expect(linux).toHaveAttribute('aria-pressed', 'true');
  await modal.locator('#modal-close-btn').click();
  await card.getByRole('button', { name: 'Delete device' }).click();
  await page.getByRole('dialog', { name: 'Delete device' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('the themed workspace stays in the current tab and a saved login is released only on connect', async ({ page, context }) => {
  const profile = { id, name: 'Office Windows', revision: 4, tags: [], host: '8.8.8.8', route: 'direct', hasLogin: true, fingerprint: 'ab'.repeat(32) };
  const get = (path: string, json: unknown) => page.route(path, r => r.request().method() === 'GET' ? r.fulfill({ json }) : r.fallback());
  await get('**/api/config', { turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github', rdpEnabled: true });
  await get('**/api/auth/me', { id: 1, github_id: 42, username: 'tester', avatar_url: null });
  let released = 0;
  const now = Date.now();
  const username = 'Ops <User>';
  await get('**/api/servers', [{ ...ssh, last_connected_at: now - 60000 }]);
  await page.route('**/api/rdp/profiles', r => r.request().method() === 'GET' ? r.fulfill({ json: { profiles: [
    { ...profile, username, last_connected_at: released ? now : null },
    { ...profile, id: '12345678-1234-1234-1234-123456789abd', name: 'Legacy', route: 'tunnel', host: 'office.example.com', hasLogin: false, username: null, last_connected_at: null },
  ] } }) : r.fallback());
  await get(`**/api/rdp/profiles/${id}`, profile);
  const asset = (name: string) => readFileSync(`${__dirname}/../../src/worker/rdp-client/${name}.rdp-text`, 'utf8');
  await page.route(`**/rdp/${id}/client`, r => r.fulfill({ contentType: 'text/html', body: asset('index') }));
  await page.route('**/rdp/assets/desktop.js', r => r.fulfill({ contentType: 'text/javascript', body: asset('desktop') }));
  await page.route('**/rdp/assets/rdp-socket.js', r => r.fulfill({ contentType: 'text/javascript', body: `window.createCloudSshRdpSocket = () => ({ probe() { this.onRelayRtt(24); }, reportDesktopReady() { this.onDesktopRecorded(); }, close() {} })` }));
  await page.route('**/rdp/assets/sdl-freerdp.wasm', r => r.fulfill({ contentType: 'application/wasm', body: Buffer.from([0,97,115,109,1,0,0,0]) }));
  await page.route('**/rdp/assets/sdl-freerdp.js', r => r.fulfill({ contentType: 'text/javascript', body: `
    const m = window.Module;
    m.callMain = args => {
      document.documentElement.dataset.loginOk = String(args.includes('/u:test-user') && m.takeWindowsPassword() === 'synthetic' && !m.takeWindowsPassword());
      const stage = document.getElementById('stage');
      document.documentElement.dataset.initialViewport = '/size:' + (stage.clientWidth & ~1) + 'x' + (stage.clientHeight & ~1);
      document.documentElement.dataset.size = args.find(a => a.startsWith('/size:'));
      document.documentElement.dataset.dynamic = String(args.includes('/dynamic-resolution'));
      window.addEventListener('resize', () => { document.documentElement.dataset.requestedWidth = document.getElementById('stage').style.getPropertyValue('--desktop-width'); });
      m.createRdpSocket(m.websocket.url);
      m._cloudssh_take_rdp_rtt = () => 83;
      m.onWindowsDisplayControl(); m.onWindowsFirstFrame();
    }; m.onRuntimeInitialized();` }));
  await page.route(`**/api/rdp/profiles/${id}/connect`, r => {
    if (r.request().method() !== 'POST') return r.fallback();
    expect(r.request().headers()['x-cloudssh-rdp-saved-revision']).toBe('4');
    released++;
    return r.fulfill({ json: { ticket: '1'.repeat(64), revision: 4, login: { username: 'test-user', password: 'synthetic', domain: '' } } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { document.body.dataset.copiedHost = value; },
    } });
    if (!crossOriginIsolated) Object.defineProperty(window, 'crossOriginIsolated', { value: true });
    if (typeof SharedArrayBuffer !== 'function') Object.defineProperty(window, 'SharedArrayBuffer', { value: ArrayBuffer });
  });
  await page.goto('/?lang=en-US');
  const card = page.getByRole('button', { name: 'Open desktop' });
  await expect(card).toBeVisible();
  const firstCard = page.locator('#server-grid .server-card-title').first();
  await expect(firstCard).toHaveText('Linux workstation');
  const windowsCard = page.locator(`#rdp-card-${id}`);
  const direct = windowsCard.getByRole('button', { name: 'Click to copy full IP address' });
  await expect(windowsCard.locator('.server-card-meta-row').first()).toContainText('Host');
  await expect(direct).toHaveText('8.8.*.*:3389');
  await direct.click();
  await expect(page.locator('body')).toHaveAttribute('data-copied-host', '8.8.8.8');
  const tunnel = page.locator('.server-card').filter({ hasText: 'Legacy' }).getByRole('button', { name: 'Click to copy full hostname' });
  await expect(tunnel).toHaveText('office.example.com');
  await tunnel.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-copied-host', 'office.example.com');
  expect(released).toBe(0);
  const search = page.locator('#server-search');
  await search.fill('ops <user>');
  await expect(firstCard).toHaveText('Office Windows');
  await expect(page.locator(`#rdp-card-${id}`)).toContainText(username);
  await expect(page.locator(`#rdp-card-${id}`)).toContainText('No record yet');
  await search.fill('');
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.locator('#server-modal #server-rdp-user')).toHaveValue('Administrator');
  await expect(page.locator('#server-modal #server-rdp-password')).toHaveAttribute('required');
  await page.locator('#modal-close-btn').click();
  expect(released).toBe(0);
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/rdp/${id}$`));
  const workspace = page.locator('.rdp-workspace[open]');
  const frame = workspace.frameLocator('iframe');
  await expect(frame.locator('html')).toHaveAttribute('data-login-ok', 'true');
  await expect(frame.locator('html')).toHaveAttribute('data-dynamic', 'true');
  const stage = frame.locator('#stage');
  // Measure the initial viewport at callMain, not after the status line changes on first paint.
  await expect(frame.locator('html')).toHaveAttribute('data-size', (await frame.locator('html').getAttribute('data-initial-viewport'))!);
  await expect(frame.locator('form,input,#connect')).toHaveCount(0);
  await expect(frame.locator('#latency')).toHaveText('Relay 24 ms · RDP 83 ms');
  expect(await frame.locator('html').evaluate(e => e.style.getPropertyValue('--accent').trim())).toBe(await page.locator('body').evaluate(e => getComputedStyle(e).getPropertyValue('--accent').trim()));
  await page.setViewportSize({ width: 960, height: 700 });
  await expect(frame.locator('html')).toHaveAttribute('data-requested-width', '960px');
  const toolbar = workspace.locator('header');
  await expect(toolbar.getByRole('heading')).toHaveText('Remote Desktop · Office Windows');
  await expect(toolbar.getByRole('button')).toHaveText(['Disconnect', 'Full screen', 'Back']);
  await expect(frame.locator('header')).toHaveCount(0);
  const full = toolbar.getByRole('button', { name: 'Full screen' });
  const inFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  expect(await inFullscreen()).toBe(false);
  await frame.locator('#canvas').click(); // Activating the desktop is not opting in to display fullscreen.
  expect(await inFullscreen()).toBe(false);
  await expect(frame.locator('#stage-label')).toBeHidden();
  const fullscreenSupported = await page.evaluate(() => !!document.fullscreenEnabled);
  if (fullscreenSupported) {
    await expect(full).toBeEnabled();
    expect(await stage.evaluate(() => !!document.fullscreenEnabled)).toBe(false); // WASM cannot request it.
    await full.click();
    await expect.poll(() => workspace.locator('iframe').evaluate(e => document.fullscreenElement === e)).toBe(true);
    await expect(frame.locator('#stage-label')).toBeVisible();
    await expect(frame.locator('.status-row')).toBeHidden();
    await page.evaluate(() => document.exitFullscreen());
    await expect(frame.locator('.status-row')).toBeVisible();
  } else await expect(full).toBeDisabled();
  await toolbar.getByRole('button', { name: 'Disconnect' }).click();
  await expect(frame.locator('#status')).toHaveText('Connection ended. Return to the server list to reconnect.');
  await expect(full).toBeDisabled();
  expect(context.pages()).toHaveLength(1);
  expect(released).toBe(1);
  await workspace.getByRole('button', { name: 'Back' }).click();
  await expect(workspace).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(firstCard).toHaveText('Office Windows');
  await expect(page.locator(`#rdp-card-${id}`)).not.toContainText('No record yet');
  await page.goto(`/rdp/${id}`); // A pasted URL is not a second user-authorized connect action.
  await expect(card).toBeVisible();
  await expect(workspace).toHaveCount(0);
  expect(released).toBe(1);
});

for (const scenario of ['accept', 'cancel', 'saved match', 'saved mismatch', 'save failed'] as const) {
  test(`Windows certificate: ${scenario}`, async ({ page }) => {
    const fingerprint = 'ab'.repeat(32);
    const other = 'cd'.repeat(32);
    const saved = scenario === 'saved match' ? fingerprint : scenario === 'saved mismatch' ? other : null;
    const path = `/api/rdp/profiles/${id}`;
    let attempts = 0;
    const asset = (name: string) => readFileSync(`${__dirname}/../../src/worker/rdp-client/${name}.rdp-text`, 'utf8');
    await page.route(`**/rdp/${id}`, r => r.fulfill({ contentType: 'text/html', body: `<iframe src="/rdp/${id}/client" data-connect-saved="true"></iframe>` }));
    await page.route(`**/rdp/${id}/client`, route => route.fulfill({
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
      ? route.fulfill({ json: { id, name: 'Windows workstation', revision: 1, hasLogin: true, fingerprint: saved } }) : route.fallback());
    await page.route(`**${path}/connect`, route => route.request().method() === 'POST'
      ? route.fulfill({ json: { ticket: '1'.repeat(64), revision: 1, login: { username: 'test-user', domain: '', password: 'synthetic' } } }) : route.fallback());
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
    const runner = page.frameLocator('iframe');
    const result = () => runner.locator('html').evaluate(() => Reflect.get(window, 'certificateResult'));
    const decision = () => runner.locator('html').evaluate(() => Reflect.get(window, 'Module').onWindowsCertificate(null));
    const dialog = runner.locator('#certificate');
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
        if (scenario === 'cancel') await dialog.locator('#certificate-cancel').press('Escape');
        else await dialog.getByRole('button', { name: 'Trust and connect' }).click();
        await expect(dialog).toBeHidden();
        await expect.poll(decision).toBe(scenario === 'accept' ? 1 : -1);
      }
    }
    expect(attempts).toBe(scenario === 'accept' || scenario === 'save failed' ? 1 : 0);
  });
}
