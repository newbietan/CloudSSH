import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures';

const id = '12345678-1234-1234-1234-123456789abc';
const ssh = {
  id: 1, user_id: 1, name: 'Linux workstation', host: 'ssh.example.com', port: 22,
  username: 'deploy', auth_method: 'password', tags: [], created_at: '', updated_at: '',
};

/** Check the visible canvas, not just the element around the embedded document. */
async function expectFullscreenFit(page: Page, checkHits = false) {
  const viewport = page.locator('.rdp-shell:fullscreen .rdp-viewport');
  await expect.poll(() => viewport.evaluate(e => {
    const frame = e.querySelector('iframe')!;
    const canvas = frame.contentDocument!.querySelector('canvas')!.getBoundingClientRect();
    const area = e.getBoundingClientRect(), rect = frame.getBoundingClientRect();
    const sx = rect.width / frame.clientWidth, sy = rect.height / frame.clientHeight;
    return Math.max(Math.abs(rect.left + canvas.left * sx - area.left), Math.abs(rect.left + canvas.right * sx - area.right),
      Math.abs(rect.top + canvas.top * sy - area.top), Math.abs(rect.top + canvas.bottom * sy - area.bottom));
  })).toBeLessThan(1);
  if (!checkHits) return;
  const canvas = page.frameLocator('.rdp-viewport iframe').locator('#canvas');
  const box = (await viewport.boundingBox())!;
  for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1], [.5, .5]]) {
    await canvas.evaluate((e: HTMLCanvasElement) => {
      delete e.dataset.hit;
      e.addEventListener('pointerdown', event => {
        const r = e.getBoundingClientRect();
        e.dataset.hit = JSON.stringify([(event.clientX - r.x) / r.width, (event.clientY - r.y) / r.height]);
      }, { once: true });
    });
    await page.mouse.click(box.x + 2 + (box.width - 4) * x, box.y + 2 + (box.height - 4) * y);
    const [u, v] = JSON.parse(await canvas.getAttribute('data-hit') ?? '[]') as number[];
    expect(Math.abs(u - x)).toBeLessThan(.02);
    expect(Math.abs(v - y)).toBeLessThan(.02);
  }
}

test('Windows uses the shared add-server dialog and the main server grid', async ({ page }) => {
  await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github', rdpEnabled: true,
  } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET' ? route.fulfill({ json: [ssh] }) : route.fallback());
  let profiles: Record<string, unknown>[] = [];
  let saved: Record<string, unknown> | undefined;
  let portEdit: Record<string, unknown> | undefined;
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
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      if (body.port === 54321) {
        portEdit = body;
        profiles = [{ ...profiles[0], port: body.port, revision: 2 }];
        return route.fulfill({ json: profiles[0] });
      }
      expect(body).toMatchObject({ name: 'Renamed device', port: 53389, revision: 1 });
      expect(body).not.toHaveProperty('login');
      return route.fulfill({ status: 409, json: { code: 'profile_changed', detail: 'never render this detail' } });
    }
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
  const rdp = modal.locator('#server-rdp-fields');
  const port = rdp.getByRole('spinbutton', { name: 'Port', exact: true });
  const portInput = rdp.locator('#server-rdp-port');
  await expect(port).toHaveValue('3389');
  await expect(port).toHaveAttribute('min', '1');
  await expect(port).toHaveAttribute('max', '65535');
  for (const [field, glyph, label] of [['name', 'label', 'Device name'], ['user', 'person', 'Username'], ['password', 'key', 'Password']]) {
    const icon = rdp.locator(`label[for="server-rdp-${field}"] .material-symbols-outlined[aria-hidden="true"]`);
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText(glyph);
    await expect(icon).toHaveCSS('font-size', '16px');
    await expect(rdp.locator(`#server-rdp-${field}`)).toHaveAccessibleName(label);
  }
  const hostBox = (await rdp.locator('#server-rdp-host').boundingBox())!;
  const portBox = (await port.boundingBox())!;
  if (await page.evaluate(() => matchMedia('(min-width:480px)').matches)) expect(portBox.x).toBeGreaterThan(hostBox.x + hostBox.width);
  else expect(portBox.y).toBeGreaterThan(hostBox.y + hostBox.height);
  await port.fill('53389');
  await modal.getByLabel('Device name').fill('Windows workstation');
  await modal.getByLabel('Connection route').selectOption('tunnel');
  await expect(portInput).toBeHidden();
  await expect(portInput).toBeDisabled();
  await expect(portInput).not.toHaveAttribute('required');
  await expect(rdp.locator('.ssh-host-field')).toHaveClass(/ssh-host-field-wide/);
  const clientSecret = modal.getByLabel('Client Secret', { exact: true });
  await expect(clientSecret).toBeVisible();
  await modal.getByLabel('Connection route').selectOption('direct');
  await expect(clientSecret).toBeHidden();
  await expect(port).toHaveValue('53389'); // Switching routes keeps the direct draft, not a Tunnel port.
  await linux.click();
  await expect(portInput).toBeDisabled();
  await expect(modal.locator('#server-port')).toHaveValue('22');
  await expect(modal.locator('#server-name')).toHaveValue('SSH draft');
  await windows.click();
  await expect(modal.getByLabel('Device name')).toHaveValue('Windows workstation');
  await modal.getByLabel('IP address or hostname').fill('93.184.215.14');
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
  for (const invalid of ['', '0', '65536', '3389.5', '443']) {
    await port.fill(invalid);
    expect(await port.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
    await modal.locator('#server-submit-btn').click();
    expect(saved).toBeUndefined();
  }
  await port.fill('53389');
  await modal.locator('#server-submit-btn').click();
  const card = page.locator(`#server-grid #rdp-card-${id}`);
  await expect(card.getByRole('button', { name: 'Open desktop' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Click to copy full IP address' })).toHaveText('93.184.*.*:53389');
  expect(saved).toEqual({ name: 'Windows workstation', route: 'direct', host: '93.184.215.14', port: 53389, tags: ['Office', 'Windows'], login: { username: 'custom-user', domain: 'WORK', password: 'synthetic' } });
  await expect(card).toContainText('Office');
  await page.locator('#server-tag-filter').selectOption('Office');
  await expect(card).toBeVisible();
  await expect(page.locator('#server-grid')).not.toContainText('Linux workstation');
  await card.getByRole('button', { name: 'Edit device' }).click();
  await expect(modal.getByLabel('Device name')).toHaveValue('Windows workstation');
  await expect(modal.locator('#server-rdp-user')).toHaveValue('custom-user');
  await expect(modal.locator('#server-rdp-domain')).toHaveValue('WORK');
  await expect(port).toHaveValue('53389');
  await expect(modal.locator('#server-rdp-password')).toHaveValue('');
  await expect(modal.locator('#server-rdp-password')).not.toHaveAttribute('required');
  const submit = modal.locator('#server-submit-btn');
  await expect(submit).toBeDisabled();
  await modal.getByLabel('Device name').fill('Windows workstation ');
  await modal.locator('#server-rdp-tags').fill('Office， Windows, Office');
  await expect(submit).toBeDisabled();
  await page.locator('#server-form').evaluate(form => (form as HTMLFormElement).requestSubmit());
  await expect(modal).toBeVisible();
  await modal.getByLabel('Device name').fill('Renamed device');
  await expect(submit).toBeEnabled();
  await expect(modal.getByText(/disconnect active CloudSSH desktops/)).toBeVisible();
  await submit.click();
  await expect(page.getByText(/Device settings changed/)).toBeVisible();
  await expect(page.getByText('never render this detail')).toHaveCount(0);
  // On a narrow screen the dismissible notification overlaps the next save action.
  await page.getByRole('alert').filter({ hasText: /Device settings changed/ }).getByRole('button').click();
  await modal.getByLabel('Device name').fill('Windows workstation');
  await modal.locator('#server-rdp-password').fill('replacement');
  await expect(submit).toBeEnabled();
  await modal.locator('#server-rdp-password').fill('');
  await expect(submit).toBeDisabled();
  await modal.locator('#server-rdp-user').fill('different-user');
  await expect(modal.locator('#server-rdp-password')).toHaveAttribute('required');
  await expect(windows).toBeHidden();
  await modal.locator('#server-rdp-user').fill('custom-user');
  await port.fill('54321');
  await expect(modal.locator('#server-rdp-password')).toHaveAttribute('required');
  await submit.click();
  expect(portEdit).toBeUndefined();
  await port.fill('53389');
  await expect(submit).toBeDisabled();
  await expect(modal.locator('#server-rdp-password')).not.toHaveAttribute('required');
  await port.fill('54321');
  await modal.locator('#server-rdp-password').fill('new-endpoint');
  await submit.click();
  await expect(card.getByRole('button', { name: 'Click to copy full IP address' })).toHaveText('93.184.*.*:54321');
  expect(portEdit).toMatchObject({ port: 54321, revision: 1, login: { password: 'new-endpoint' } });
  await card.getByRole('button', { name: 'Delete device' }).click();
  await page.getByRole('dialog', { name: 'Delete device' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.locator('#add-server-btn').click();
  await expect(linux).toHaveAttribute('aria-pressed', 'true');
  await windows.click();
  await expect(port).toHaveValue('3389');
  await port.fill('65536'); // A stale invalid direct draft must not block or enter a Tunnel save.
  await rdp.getByLabel('Connection route').selectOption('tunnel');
  await rdp.getByLabel('Device name').fill('Tunnel');
  await rdp.locator('#server-rdp-host').fill('rdp.example.com');
  await rdp.locator('#server-rdp-password').fill('tunnel-example');
  await submit.click();
  await expect(card.getByRole('button', { name: 'Click to copy full hostname' })).toHaveText('rdp.example.com');
  expect(saved).toMatchObject({ route: 'tunnel', host: 'rdp.example.com' });
  expect(saved).not.toHaveProperty('port');
});

for (const { input, host, alternate, badge, copyLabel } of [
  { input: ' RDP.Example.COM. ', host: 'rdp.example.com', alternate: 'Rdp.Example.Com', badge: 'rdp.example.com:53389', copyLabel: 'Click to copy full hostname' },
  { input: '[2600:0001:ABCD::1]', host: '2600:1:abcd::1', alternate: '2600:1:ABCD:0:0:0:0:1', badge: '[2600:1:…]:53389', copyLabel: 'Click to copy full IP address' },
]) {
  test(`Windows supports a canonical public direct endpoint: ${host}`, async ({ page }) => {
    await page.route('**/api/config', r => r.request().method() === 'GET' ? r.fulfill({ json: {
      turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github', rdpEnabled: true,
    } }) : r.fallback());
    await page.route('**/api/auth/me', r => r.request().method() === 'GET' ? r.fulfill({ json: {
      id: 1, github_id: 42, username: 'tester', avatar_url: null,
    } }) : r.fallback());
    await page.route('**/api/servers', r => r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fallback());
    let saved: Record<string, unknown> | undefined;
    let profiles: Record<string, unknown>[] = [];
    await page.route('**/api/rdp/profiles', r => {
      if (r.request().method() === 'GET') return r.fulfill({ json: { profiles } });
      if (r.request().method() !== 'POST') return r.fallback();
      saved = r.request().postDataJSON();
      const { login: _login, ...metadata } = saved!;
      profiles = [{ ...metadata, id, revision: 1, hasAccessToken: false, hasLogin: true }];
      return r.fulfill({ status: 201, json: profiles[0] });
    });
    await page.route(`**/api/rdp/profiles/${id}/login-identity`, r => r.request().method() === 'POST'
      ? r.fulfill({ json: { revision: 1, username: 'Administrator', domain: '' } }) : r.fallback());
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { document.body.dataset.copiedHost = text; } } });
    });
    await page.goto('/?lang=en-US');
    await page.locator('#add-server-btn').click();
    const modal = page.locator('#server-modal');
    await modal.getByRole('button', { name: 'Windows Server' }).click();
    const address = modal.getByRole('textbox', { name: 'IP address or hostname' });
    await modal.getByLabel('Device name').fill('Dual-stack Windows');
    const password = modal.locator('#server-rdp-password');
    await password.fill('synthetic');
    await modal.getByRole('spinbutton', { name: 'Port', exact: true }).fill('53389');
    const submit = modal.locator('#server-submit-btn');
    for (const invalid of ['127.0.0.1', 'fd00::1', 'rdp.example.com:3389']) {
      await address.fill(invalid);
      expect(await address.evaluate((el: HTMLInputElement) => el.validationMessage)).toContain('Enter a public IPv4 address');
      await submit.click();
      expect(saved).toBeUndefined();
    }
    await address.fill(input);
    await submit.click();
    const card = page.locator(`#rdp-card-${id}`);
    const copy = card.getByRole('button', { name: copyLabel });
    await expect(copy).toHaveText(badge);
    expect(saved).toMatchObject({ host, port: 53389, route: 'direct' });
    await copy.click();
    await expect(page.locator('body')).toHaveAttribute('data-copied-host', host);
    await card.getByRole('button', { name: 'Edit device' }).click();
    await expect(address).toHaveValue(host);
    await expect(modal.locator('#server-rdp-user')).toHaveValue('Administrator');
    await address.fill(alternate);
    await expect(submit).toBeDisabled();
    await expect(password).not.toHaveAttribute('required');
    await address.fill('another.example.net');
    await expect(submit).toBeEnabled();
    await expect(password).toHaveAttribute('required');
  });
}

test('the themed workspace stays in the current tab and a saved login is released only on connect', async ({ page, context, browserName }) => {
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
  const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  await page.route('**/?lang=en-US', async r => {
    const response = await r.fetch();
    return r.fulfill({ response, headers: { ...response.headers(), ...isolation } });
  });
  await page.route(`**/rdp/${id}/client`, r => r.fulfill({ contentType: 'text/html', headers: isolation, body: asset('index') }));
  await page.route('**/rdp/assets/desktop.js', r => r.fulfill({ contentType: 'text/javascript', body: asset('desktop') }));
  await page.route('**/rdp/assets/rdp-socket.js', r => r.fulfill({ contentType: 'text/javascript', body: `window.createCloudSshRdpSocket = () => ({ probe() { this.onRelayRtt(24); }, reportDesktopReady() { this.onDesktopRecorded(); }, close() { sessionStorage.setItem('test-rdp-closed', 'yes'); } })` }));
  await page.route('**/rdp/assets/sdl-freerdp.wasm', r => r.fulfill({ contentType: 'application/wasm', body: Buffer.from([0,97,115,109,1,0,0,0]) }));
  await page.route('**/rdp/assets/sdl-freerdp.js', r => r.fulfill({ contentType: 'text/javascript', body: `
    const m = window.Module;
    m.FS = { mkdirTree() {}, writeFile() {} };
    m.callMain = args => {
      document.documentElement.dataset.loginOk = String(args.includes('/u:test-user') && m.takeWindowsPassword() === 'synthetic' && !m.takeWindowsPassword());
      const stage = document.getElementById('stage');
      document.documentElement.dataset.initialViewport = '/size:' + (stage.clientWidth & ~1) + 'x' + (stage.clientHeight & ~1);
      document.documentElement.dataset.size = args.find(a => a.startsWith('/size:'));
      document.documentElement.dataset.dynamic = String(args.includes('/dynamic-resolution'));
      window.addEventListener('resize', () => {
        document.documentElement.dataset.requestedWidth = stage.style.getPropertyValue('--desktop-width');
        document.documentElement.dataset.requestedHeight = stage.style.getPropertyValue('--desktop-height');
      });
      m.createRdpSocket(m.websocket.url);
      m._cloudssh_take_rdp_rtt = () => 83;
      m.onWindowsFirstFrame();
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
    // This case uses a stub WASM. Mobile WebKit's HTTP test context can lack SAB even with real COOP/COEP.
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
  // Keep an offline SSH tab behind the workspace so its global Esc shortcut would be active.
  await page.evaluate(async () => {
    const path = '/src/main.ts';
    (await import(path)).getTabManager().createTab('Background SSH');
  });
  const redundant: string[] = [];
  page.on('request', req => {
    if (/\/api\/(?:config|servers)$/.test(req.url()) || (req.isNavigationRequest() && req.frame() === page.mainFrame())) redundant.push(req.url());
  });
  await search.fill('ops <user>');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await card.click(); // Keep the original authenticated page and its DOM alive.
  await expect(page).toHaveURL(new RegExp(`/rdp/${id}$`));
  const workspace = page.locator('.rdp-workspace[open]');
  const frame = workspace.frameLocator('iframe');
  await expect.poll(() => frame.locator('html').evaluate(() => [window.crossOriginIsolated, window.isSecureContext])).toEqual([true, true]);
  await expect(frame.locator('html')).toHaveAttribute('data-login-ok', 'true');
  await expect(page.locator('#app-loading')).toHaveCount(0);
  expect(redundant).toEqual([]);
  await expect(frame.locator('html')).toHaveAttribute('data-dynamic', 'true');
  const stage = frame.locator('#stage');
  // Measure the initial viewport at callMain, not after the status line changes on first paint.
  await expect(frame.locator('html')).toHaveAttribute('data-size', (await frame.locator('html').getAttribute('data-initial-viewport'))!);
  await expect(frame.locator('form,input,#connect')).toHaveCount(0);
  await expect(workspace.locator('header .rdp-latency')).toHaveText('Relay 24 ms · RDP 83 ms');
  await expect(frame.locator('.status-row')).toHaveCount(0);
  expect(await frame.locator('html').evaluate(e => e.style.getPropertyValue('--accent').trim())).toBe(await page.locator('body').evaluate(e => getComputedStyle(e).getPropertyValue('--accent').trim()));
  await page.setViewportSize({ width: 960, height: 700 });
  await expect.poll(() => stage.evaluate(e => e.clientWidth)).toBe(960);
  const toolbar = workspace.locator('header');
  const resolution = toolbar.getByRole('combobox', { name: 'Full-screen desktop resolution', includeHidden: true });
  await expect(resolution).toBeHidden();
  await expect(toolbar.getByRole('heading')).toHaveText('Remote Desktop · Office Windows');
  await expect(toolbar.getByRole('button')).toHaveText(['Full screen', 'Back']);
  await expect(frame.locator('header')).toHaveCount(0);
  const full = toolbar.getByRole('button', { name: 'Full screen' });
  const inFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  expect(await inFullscreen()).toBe(false);
  const canvas = frame.locator('#canvas');
  await test.step('first frame takes keyboard input without an activation click', async () => {
    await expect(canvas).toBeFocused();
    await canvas.evaluate((el: HTMLCanvasElement) => {
      for (const type of ['keydown', 'keyup'] as const) el.addEventListener(type, e => {
        el.dataset.keys = (el.dataset.keys ?? '') + `${type}:${e.code};`;
      });
    });
    await page.keyboard.press('Enter');
    await page.keyboard.down('ShiftRight');
    await page.keyboard.press('KeyD');
    await page.keyboard.up('ShiftRight');
    await expect(canvas).toHaveAttribute('data-keys', 'keydown:Enter;keyup:Enter;keydown:ShiftRight;keydown:KeyD;keyup:KeyD;keyup:ShiftRight;');
    await expect(workspace).toBeVisible();
  });
  await test.step('a desktop right-click cancels only the browser menu', async () => {
    await canvas.evaluate((el: HTMLCanvasElement) => {
      el.dataset.rightButtons = '';
      for (const type of ['mousedown', 'mouseup'] as const) {
        el.addEventListener(type, e => { if (e.button === 2) el.dataset.rightButtons += `${type};`; });
      }
      el.addEventListener('contextmenu', e => { el.dataset.menuCanceled = String(e.defaultPrevented); }, { once: true });
    });
    await canvas.click({ button: 'right' });
    await expect(canvas).toHaveAttribute('data-right-buttons', 'mousedown;mouseup;');
    await expect(canvas).toHaveAttribute('data-menu-canceled', 'true');
    // Fingerprint text is inside the same iframe but must keep its normal copy/context menu.
    expect(await frame.locator('#certificate-fingerprint').evaluate(el =>
      el.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })),
    )).toBe(true);
  });
  await test.step('side buttons keep their remote input without navigating browser history', async () => {
    // Check the scope even on engines without trusted X1/X2 injection.
    const mouseups = await canvas.evaluate(el => [0, 1, 2, 3, 4].map(button =>
      el.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })),
    ));
    expect(mouseups).toEqual([true, true, true, false, false]);
    expect(await toolbar.evaluate(el => el.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true })))).toBe(true);
    if (browserName !== 'chromium') return;
    await canvas.evaluate((el: HTMLCanvasElement) => {
      for (const type of ['pointerdown', 'pointerup'] as const) el.addEventListener(type, e => {
        el.dataset.sideButtons = (el.dataset.sideButtons ?? '') + `${type}:${e.button};`;
      });
    });
    const cdp = await context.newCDPSession(page);
    try {
      const box = (await canvas.boundingBox())!;
      for (const button of ['back', 'forward'] as const) {
        const pos = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2), button, clickCount: 1 };
        await cdp.send('Input.dispatchMouseEvent', { ...pos, type: 'mousePressed', buttons: button === 'back' ? 8 : 16 });
        await cdp.send('Input.dispatchMouseEvent', { ...pos, type: 'mouseReleased', buttons: 0 });
      }
    } finally { await cdp.detach(); }
    await expect(canvas).toHaveAttribute('data-side-buttons', 'pointerdown:3;pointerup:3;pointerdown:4;pointerup:4;');
    await expect(page).toHaveURL(new RegExp(`/rdp/${id}$`));
  });
  // The local toolbar must not give the global SSH shortcut access to the background view.
  await toolbar.getByRole('button', { name: 'Back' }).press('Escape');
  await expect(workspace).toBeVisible();
  await expect(page.locator('#terminal-section')).toBeHidden();
  await canvas.click(); // Activating the desktop is not opting in to display fullscreen.
  expect(await inFullscreen()).toBe(false);
  const frameSize = () => stage.evaluate(e => [innerWidth, innerHeight, e.clientWidth, e.clientHeight]);
  const initialSize = await frameSize();
  const fullscreenSupported = await page.evaluate(() => !!document.fullscreenEnabled);
  if (fullscreenSupported) {
    await expect(full).toBeEnabled();
    expect(await stage.evaluate(() => !!document.fullscreenEnabled)).toBe(false); // WASM cannot request it.
    const exit = toolbar.getByRole('button', { name: 'Exit full screen' });
    for (const how of ['button', 'browser', 'back']) {
      await full.click();
      await expect.poll(() => workspace.locator('.rdp-shell').evaluate(e => document.fullscreenElement === e)).toBe(true);
      await expect(exit).toBeVisible();
      await expect(canvas).toBeFocused();
      await page.keyboard.press('Enter'); // Input for Windows, not a second toolbar toggle.
      expect(await inFullscreen()).toBe(true);
      expect(await frameSize()).toEqual(initialSize);
      await expect(workspace.locator('header .rdp-latency')).toBeVisible();
      expect(await stage.evaluate(e => e.getBoundingClientRect().top)).toBe(0);
      const headerRect = (await toolbar.boundingBox())!;
      const viewport = workspace.locator('.rdp-viewport');
      expect(Math.abs((await viewport.boundingBox())!.y - headerRect.y - headerRect.height)).toBeLessThan(2);
      await expectFullscreenFit(page);
      expect(headerRect.height).toBeLessThanOrEqual(await page.evaluate(() => matchMedia('(pointer: fine)').matches ? 34 : 48));
      if (how === 'back') break; // Back must end the live session even from fullscreen.
      if (how === 'button') {
        // CDP cannot resize a fullscreen OS window. Simulate wide and tall display areas inside it.
        // Also model a fixed-resolution canvas already letterboxed inside its document.
        const canvas = frame.locator('#canvas');
        await canvas.evaluate(e => { e.style.setProperty('width', '70%', 'important'); e.style.setProperty('height', '62%', 'important'); });
        for (const [width, height] of [['62%', '80%'], ['96%', '52%']]) {
          await viewport.evaluate((e, [w, h]) => { e.style.flex = 'none'; e.style.width = w; e.style.height = h; }, [width, height]);
          await expectFullscreenFit(page, true);
          expect(await frameSize()).toEqual(initialSize);
        }
        await canvas.evaluate(e => { e.style.removeProperty('width'); e.style.removeProperty('height'); });
        await viewport.evaluate(e => { e.style.removeProperty('flex'); e.style.removeProperty('width'); e.style.removeProperty('height'); });
        await expect(resolution).toBeHidden(); // No requests or selector until DISP is negotiated.
        await expect(frame.locator('html')).not.toHaveAttribute('data-requested-width');
        await stage.evaluate(() => (window as unknown as { Module: { onWindowsDisplayControl(): void } }).Module.onWindowsDisplayControl());
        await expect(resolution).toHaveValue('local');
        await expect(frame.locator('html')).toHaveAttribute('data-requested-width', '960px');
        await resolution.selectOption('fit');
        const setArea = (w: number, h: number) => viewport.evaluate((e, [width, height]) => {
          e.style.flex = 'none'; e.style.width = `${width}px`; e.style.height = `${height}px`;
        }, [w, h]);
        for (const [w, h] of [[701, 401], [801, 451]]) {
          await setArea(w, h);
          await expect(frame.locator('html')).toHaveAttribute('data-requested-width', `${w - 1}px`);
          await expect(frame.locator('html')).toHaveAttribute('data-requested-height', `${h - 1}px`);
          await expectFullscreenFit(page, true);
        }
        await resolution.selectOption('720p');
        await expect(frame.locator('html')).toHaveAttribute('data-requested-width', '1280px');
        await expect(frame.locator('html')).toHaveAttribute('data-requested-height', '720px');
        await expectFullscreenFit(page, true);
        await resolution.selectOption('local');
        await expect(frame.locator('html')).toHaveAttribute('data-requested-width', '960px');
        await viewport.evaluate(e => { e.style.removeProperty('flex'); e.style.removeProperty('width'); e.style.removeProperty('height'); });
        await exit.click();
      } else {
        await expect(resolution).toHaveValue('local');
        await resolution.selectOption('1080p');
        await expect(frame.locator('html')).toHaveAttribute('data-requested-width', '1920px');
        await expect(frame.locator('html')).toHaveAttribute('data-requested-height', '1080px');
        await page.keyboard.press('Escape');
        // Headless engines need not bind a synthetic key to the OS fullscreen command.
        if (await inFullscreen()) await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
      }
      await expect(full).toBeVisible();
      await expect.poll(inFullscreen).toBe(false);
      await expect(resolution).toBeHidden();
      await expect(canvas).toBeFocused();
      await expect.poll(frameSize).toEqual(initialSize);
      await expect(frame.locator('html')).toHaveAttribute('data-requested-width', '960px');
      await expect(full).toBeEnabled();
      await expect.poll(() => workspace.locator('iframe').evaluate(e => e.style.getPropertyValue('--rdp-fill-transform'))).toBe('');
    }
  } else await expect(full).toBeDisabled();
  expect(context.pages()).toHaveLength(1);
  expect(released).toBe(1);
  await workspace.getByRole('button', { name: 'Back' }).click();
  await expect(workspace).toHaveCount(0);
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-rdp-closed'))).toBe('yes');
  expect(await inFullscreen()).toBe(false);
  await expect(page).toHaveURL(/\/\?lang=en-US$/);
  await expect(search).toHaveValue('ops <user>');
  expect(redundant).toEqual([]); // Neither entry nor return refetched config/list or navigated a document.
  await expect(firstCard).toHaveText('Office Windows');
  await expect(page.locator(`#rdp-card-${id}`)).not.toContainText('No record yet');
  await page.keyboard.press('Escape'); // The normal SSH shortcut works again after RDP closes.
  await expect(page.locator('#terminal-section')).toBeVisible();
  await page.goto(`/rdp/${id}`); // A pasted URL is not a second user-authorized connect action.
  await expect(card).toBeVisible();
  await expect(workspace).toHaveCount(0);
  expect(released).toBe(1);
});

test('browser Back closes the frame before checking ownership and cannot restore a different Access account', async ({ page }) => {
  let owner = 'first@example.test';
  let checks = 0, resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  await page.route('**/api/config', r => r.request().method() === 'GET' ? r.fulfill({ json: { turnstileEnabled: false, githubAuthEnabled: false, githubAuthRequired: true, authMode: 'cf_access', rdpEnabled: true } }) : r.fallback());
  await page.route('**/api/auth/me', async r => {
    if (r.request().method() !== 'GET') return r.fallback();
    if (++checks === 2) await gate;
    return r.fulfill({ json: { id: 1, github_id: -2, username: owner, avatar_url: null } });
  });
  await page.route('**/api/servers', r => r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fallback());
  await page.route('**/api/rdp/profiles', r => r.request().method() === 'GET' ? r.fulfill({ json: { profiles: [{ id, name: owner, revision: 1, route: 'direct', host: '8.8.8.8', tags: [], hasLogin: true }] } }) : r.fallback());
  await page.route(`**/rdp/${id}/client`, r => r.fulfill({ contentType: 'text/html', body: '<p>Starting…</p><canvas id="canvas" tabindex="0"></canvas>' }));
  await page.addInitScript(() => Object.defineProperty(window, 'crossOriginIsolated', { value: true }));
  await page.goto('/?lang=en-US');
  await page.getByRole('button', { name: 'Open desktop' }).click();
  const runtime = page.locator('.rdp-workspace iframe');
  await expect(runtime).toBeVisible();
  const back = page.locator('.rdp-workspace').getByRole('button', { name: 'Back' });
  await back.focus();
  await runtime.evaluate(el => el.dispatchEvent(new Event('cloudssh-rdp-ready')));
  await expect(back).toBeFocused(); // Do not override a deliberate keyboard choice on first frame.
  owner = 'second@example.test'; // Same numeric sentinels; must check the full identity.
  await page.evaluate(() => history.back());
  try {
    await expect(page.locator('.rdp-workspace:modal')).toContainText('Returning to your servers');
    await expect(page.locator('.rdp-workspace iframe')).toHaveCount(0);
    expect(checks).toBe(2);
  } finally { resume(); }
  await expect(page.locator('.server-card-title')).toHaveText(owner);
  expect(checks).toBe(3); // Fresh bootstrap, never reveal the old account list.
});

test('isolated desktop entry hides the home loader before JS; Back also works before first frame', async ({ page }) => {
  const path = `/rdp/${id}`;
  await page.goto('/?lang=en-US');
  await page.evaluate(device => sessionStorage.setItem('cloudssh_rdp_open_once', JSON.stringify({ id: device, until: Date.now() + 30000 })), id);
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  await page.route('**/src/main.ts', async r => { await gate; await r.fallback(); });
  await page.route(`**${path}/client`, r => r.fulfill({ contentType: 'text/html', body: '<p>Waiting for desktop…</p>' }));
  await page.goto(path, { waitUntil: 'commit' });
  try {
    await expect(page.locator('html')).toHaveAttribute('data-rdp-entry', '');
    await expect(page.locator('#app-loading')).toBeAttached();
    await expect(page.locator('#app-loading')).toBeHidden();
    await expect(page.locator('#app')).toBeHidden();
  } finally { resume(); }
  const workspace = page.locator('.rdp-workspace[open]');
  await expect(workspace.frameLocator('iframe').getByText('Waiting for desktop…')).toBeVisible();
  await expect(workspace.getByRole('button', { name: 'Full screen' })).toBeDisabled();
  await expect(workspace.getByRole('heading')).toBeFocused();
  await page.keyboard.press('Enter'); // Loading should not default to activating Back.
  await expect(workspace).toBeVisible();
  await workspace.getByRole('button', { name: 'Back' }).press('Enter'); // Deliberate Back still works before the first frame.
  await expect(page).toHaveURL(/\/$/);
  await expect(workspace).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('cloudssh_rdp_open_once'))).toBeNull();
});

for (const scenario of ['accept', 'cancel', 'saved match', 'saved mismatch', 'save failed', 'ticket limit', 'unknown error', 'idle timeout'] as const) {
  test(`Windows connection: ${scenario}`, async ({ page }) => {
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
      m.FS = { mkdirTree() {}, writeFile() {} };
      window.certificateResult = 'not checked';
      m.callMain = () => {
        const socket = m.createRdpSocket(m.websocket.url);
        if ('${scenario}' === 'idle timeout') { socket.onRelayClose('idle_timeout'); return; }
        window.certificateResult = m.onWindowsCertificate('${fingerprint}');
      };
      m.onRuntimeInitialized();
    ` }));
    await page.route(`**${path}`, route => route.request().method() === 'GET'
      ? route.fulfill({ json: { id, name: 'Windows workstation', revision: 1, hasLogin: true, fingerprint: saved } }) : route.fallback());
    await page.route(`**${path}/connect`, route => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (scenario === 'ticket limit' || scenario === 'unknown error') return route.fulfill({ status: 429,
        json: { code: scenario === 'ticket limit' ? 'ticket_limit' : 'unrecognized', detail: 'private upstream detail' } });
      return route.fulfill({ json: { ticket: '1'.repeat(64), revision: 1, login: { username: 'test-user', domain: '', password: 'synthetic' } } });
    });
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
    if (scenario === 'ticket limit' || scenario === 'unknown error' || scenario === 'idle timeout') {
      const status = runner.locator('#status');
      await expect(status).toContainText(scenario === 'ticket limit' ? 'Too many connection attempts' :
        scenario === 'idle timeout' ? 'Disconnected after inactivity' : 'Could not start the desktop');
      await expect(status).not.toContainText('private upstream detail');
      expect(attempts).toBe(0);
      return;
    }
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

for (const scenario of ['reconnect', 'revision changed', 'fingerprint changed', 'lease ended', 'upstream write failed',
  'confirmation timeout'] as const) test(`first-use certificate recovery: ${scenario}`, async ({ page }) => {
  const fingerprint = 'ef'.repeat(32);
  let savedFingerprint: string | null = null;
  let revision = 1;
  let connectCount = 0;
  let trustCount = 0;
  if (scenario === 'confirmation timeout') await page.clock.install();
  const asset = (name: string) => readFileSync(`${__dirname}/../../src/worker/rdp-client/${name}.rdp-text`, 'utf8');
  const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  await page.route('**/api/config', r => r.request().method() === 'GET' ? r.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github', rdpEnabled: true,
  } }) : r.fallback());
  await page.route('**/api/auth/me', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : r.fallback());
  await page.route('**/api/servers', r => r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fallback());
  await page.route('**/api/rdp/profiles', r => r.request().method() === 'GET' ? r.fulfill({ json: { profiles: [
    { id, name: 'Domain Win', revision: 1, tags: [], route: 'direct', host: 'rdp.example.com', port: 53389, hasLogin: true, fingerprint: savedFingerprint, username: 'Administrator', last_connected_at: null, created_at: null, updated_at: null },
  ] } }) : r.fallback());
  await page.route(`**/api/rdp/profiles/${id}`, r => r.request().method() === 'GET'
    ? r.fulfill({ json: { id, name: 'Domain Win', revision, route: 'direct', host: 'rdp.example.com', port: 53389, hasLogin: true, fingerprint: savedFingerprint } }) : r.fallback());
  await page.route(`**/api/rdp/profiles/${id}/connect`, r => {
    if (r.request().method() !== 'POST') return r.fallback();
    expect(r.request().headers()['x-cloudssh-rdp-saved-revision']).toBe('1');
    connectCount++;
    return r.fulfill({ json: { ticket: String(connectCount).repeat(64), revision: 1, login: { username: 'Administrator', domain: '', password: 'synthetic' } } });
  });
  await page.route(`**/api/rdp/profiles/${id}/trust`, r => {
    if (r.request().method() !== 'PUT') return r.fallback();
    expect(r.request().postDataJSON()).toEqual({ fingerprint, revision: 1, lease: id });
    trustCount++;
    // The competing edit lands after the original pin was saved and before the retry reads the row.
    if (scenario === 'revision changed') revision++;
    savedFingerprint = scenario === 'fingerprint changed' ? 'cd'.repeat(32) : fingerprint;
    return r.fulfill({ json: { fingerprint } });
  });
  await page.route('**/?lang=en-US', async r => {
    const response = await r.fetch();
    return r.fulfill({ response, headers: { ...response.headers(), ...isolation } });
  });
  await page.route(`**/rdp/${id}/client`, r => r.fulfill({ contentType: 'text/html', headers: isolation, body: asset('index') }));
  await page.route('**/rdp/assets/desktop.js', r => r.fulfill({ contentType: 'text/javascript', body: asset('desktop') }));
  await page.route('**/rdp/assets/rdp-socket.js', r => r.fulfill({ contentType: 'text/javascript', body: `
    // Exercise the real browser adapter against a controlled relay, independently of native RDP.
    window.WebSocket = class {
      constructor(_url, protocol) {
        this.protocol = protocol;
        queueMicrotask(() => this.onopen?.());
      }
      control(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
      send(data) {
        if (typeof data !== 'string') return;
        const msg = JSON.parse(data);
        if (msg.type === 'ticket') {
          window.__lastTicket = msg.ticket;
          queueMicrotask(() => this.control({ type: 'ready', lease: '${id}', desktopReport: true }));
        } else if (msg.type === 'cert_wait') {
          queueMicrotask(() => {
            if ('${scenario}' !== 'upstream write failed') this.control({ type: 'cert_hold' });
            window.__certWaitSent = true;
          });
        } else if (msg.type === 'cert_done') {
          const reason = '${scenario}' === 'lease ended' ? 'lease_ended'
            : '${scenario}' === 'upstream write failed' ? 'upstream_write_failed' : 'cert_reconnect';
          queueMicrotask(() => this.onclose?.({ reason }));
        }
      }
      close() {}
    };
    ${asset('rdp-socket')}
  ` }));
  await page.route('**/rdp/assets/sdl-freerdp.wasm', r => r.fulfill({ contentType: 'application/wasm', body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) }));
  await page.route('**/rdp/assets/sdl-freerdp.js', r => r.fulfill({ contentType: 'text/javascript', body: `
    const m = window.Module;
    m.FS = { mkdirTree() {}, writeFile() {} };
    m.callMain = () => {
      const socket = m.createRdpSocket(m.websocket.url);
      socket.onopen = () => {
        if (m.onWindowsCertificate('${fingerprint}') === 1) {
          m.onWindowsDisplayControl();
          m.onWindowsFirstFrame();
        }
      };
    };
    m.onRuntimeInitialized();
  ` }));
  await page.addInitScript(() => {
    localStorage.setItem('cloudssh_locale', 'en-US');
    if (!crossOriginIsolated) Object.defineProperty(window, 'crossOriginIsolated', { value: true });
    if (typeof SharedArrayBuffer !== 'function') Object.defineProperty(window, 'SharedArrayBuffer', { value: ArrayBuffer });
  });
  await page.goto('/?lang=en-US');
  await page.getByRole('button', { name: 'Open desktop' }).click();
  const iframe = page.locator('.rdp-workspace[open] iframe');
  const frame = iframe.contentFrame();
  const dialog = frame.locator('#certificate');
  const status = frame.locator('#status');
  const fromFrame = (key: string) => frame.locator('html').evaluate((_, name) => Reflect.get(window, name), key);
  await expect.poll(() => fromFrame('__certWaitSent')).toBe(true);
  await expect(dialog).toBeVisible();
  if (scenario === 'confirmation timeout') {
    await page.clock.fastForward(85_000);
    await expect(status).toContainText('Certificate confirmation timed out');
    await expect(dialog).toBeHidden();
    expect(trustCount).toBe(0);
    expect(connectCount).toBe(1);
    return;
  }
  await dialog.getByRole('button', { name: 'Trust and connect' }).click();
  if (scenario === 'reconnect') {
    await expect(status).toContainText('Desktop ready');
    expect(await fromFrame('__lastTicket')).toBe('2'.repeat(64));
    const launchedAgain = await iframe.evaluate((node, fingerprint) => {
      const frame = node as HTMLIFrameElement;
      frame.dispatchEvent(new CustomEvent('cloudssh-rdp-reconnect', { detail: { revision: 1, fingerprint } }));
      return frame.dataset.connectSaved;
    }, fingerprint);
    expect(launchedAgain).toBeUndefined();
  } else if (scenario === 'lease ended') {
    await expect(status).toContainText('This desktop session is no longer valid');
  } else if (scenario === 'upstream write failed') {
    await expect(status).toContainText('The connection to Windows ended before the desktop appeared');
  } else {
    await expect(status).toContainText('Device settings changed');
  }
  await expect(dialog).toBeHidden();
  expect(trustCount).toBe(1);
  expect(connectCount).toBe(scenario === 'reconnect' ? 2 : 1);
});

for (const [errCode, expected] of [
  ['ERRCONNECT_AUTHENTICATION_FAILED', 'Windows rejected the sign-in credentials'],
  ['ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED', 'Security negotiation failed'],
  ['ERRCONNECT_CONNECT_TRANSPORT_FAILED', 'The connection to Windows ended before the desktop appeared'],
] as const) {
  test(`reports distinct safe error message for ${errCode}`, async ({ page }) => {
    const asset = (name: string) => readFileSync(`${__dirname}/../../src/worker/rdp-client/${name}.rdp-text`, 'utf8');
    const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    await page.route(`**/rdp/${id}`, r => r.fulfill({ contentType: 'text/html', body: `<iframe src="/rdp/${id}/client" data-connect-saved="true"></iframe>` }));
    await page.route(`**/rdp/${id}/client`, r => r.fulfill({ contentType: 'text/html', headers: isolation, body: asset('index') }));
    await page.route('**/rdp/assets/desktop.js', r => r.fulfill({ contentType: 'text/javascript', body: asset('desktop') }));
    await page.route('**/rdp/assets/rdp-socket.js', r => r.fulfill({ contentType: 'text/javascript', body: `window.createCloudSshRdpSocket = () => ({ lease: '${id}', close() { this.lease = undefined; } });` }));
    await page.route('**/rdp/assets/sdl-freerdp.wasm', r => r.fulfill({ contentType: 'application/wasm', body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) }));
    await page.route('**/rdp/assets/sdl-freerdp.js', r => r.fulfill({ contentType: 'text/javascript', body: `
      const m = window.Module;
      m.FS = { mkdirTree() {}, writeFile() {} };
      m.callMain = () => {
        m.createRdpSocket(m.websocket.url);
        m.printErr('[ERROR][com.freerdp.core] - ${errCode} [0x00020000] private-host-secret');
        m.onExit(0);
      };
      m.onRuntimeInitialized();
    ` }));
    await page.route(`**/api/rdp/profiles/${id}`, r => r.request().method() === 'GET'
      ? r.fulfill({ json: { id, name: 'Win', revision: 1, hasLogin: true, fingerprint: 'ab'.repeat(32) } }) : r.fallback());
    await page.route(`**/api/rdp/profiles/${id}/connect`, r => r.request().method() === 'POST'
      ? r.fulfill({ json: { ticket: '1'.repeat(64), revision: 1, login: { username: 'Administrator', domain: '', password: 'synthetic' } } }) : r.fallback());
    await page.addInitScript(() => {
      localStorage.setItem('cloudssh_locale', 'en-US');
      if (!crossOriginIsolated) Object.defineProperty(window, 'crossOriginIsolated', { value: true });
      if (typeof SharedArrayBuffer !== 'function') Object.defineProperty(window, 'SharedArrayBuffer', { value: ArrayBuffer });
    });
    await page.goto(`/rdp/${id}`);
    const status = page.frameLocator('iframe').locator('#status');
    await expect(status).toContainText(expected);
    await expect(status).not.toContainText('private-host-secret');
  });
}
