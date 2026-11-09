import { expect, test, type Page } from './fixtures';

const themes = ['standard-dark', 'standard-light', 'cyberpunk', 'liquid-glass'] as const;
const locales = ['zh-CN', 'zh-TW', 'en-US'] as const;
const savedServer = {
  id: 1, user_id: 1, name: 'Layout Preview', host: 'ssh.example.com', port: 65535,
  username: 'deploy', auth_method: 'publickey', cf_ssh_ca_team: 'example-team',
  jump_server_id: null, tags: ['preview'], region: null, inferred_hint: 'apac',
  created_at: '', updated_at: '',
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: {
      authMode: 'cf_access', cfAccessEmail: 'preview@example.com', cfAccessTeamName: 'example-team',
      turnstileEnabled: false, sitekey: '', githubAuthEnabled: false, githubAuthRequired: false,
      sshSharingEnabled: false,
    } });
  });
  await page.route('**/api/auth/me', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { id: 1, github_id: 1, username: 'Preview', avatar_url: null } });
  });
  await page.route('**/api/servers', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: [savedServer] });
  });
});

test.use({ contextOptions: { reducedMotion: 'reduce' } });

async function openModal(page: Page, theme: string, locale = 'zh-CN', add = false) {
  await page.addInitScript((value) => localStorage.setItem('cloudssh_theme_selection', value), theme);
  await page.goto(`/?lang=${locale}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.locator(add ? '#add-server-btn' : '#edit-1').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await page.evaluate(() => document.fonts.ready);
}

async function portGeometry(page: Page, selector = '#server-port') {
  return page.evaluate((selector) => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    const style = getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {
      visible: input.getBoundingClientRect().width > 0,
      // Reserve 24px for native number controls, in addition to both themed paddings.
      textSpace: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 24,
      textWidth: Math.max(...['65535', '45404', '10000'].map((value) => context.measureText(value).width)),
    };
  }, selector);
}

async function assertLayout(page: Page, columns: number, noScroll = false) {
  const metrics = await page.evaluate(() => {
    const fields = document.querySelector<HTMLElement>('.server-modal-fields')!;
    const rect = fields.getBoundingClientRect();
    const settings = document.querySelector<HTMLElement>('.server-settings-columns')!;
    const offenders = [...fields.querySelectorAll<HTMLElement>('input, select, textarea, button')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < rect.left - 1 || box.right > rect.right + 1);
      })
      .map((element) => element.id || element.tagName);
    return {
      columns: getComputedStyle(settings).gridTemplateColumns.split(/\s+/).length,
      horizontal: fields.scrollWidth - fields.clientWidth,
      vertical: fields.scrollHeight - fields.clientHeight,
      pageHorizontal: document.documentElement.scrollWidth - innerWidth,
      offenders,
    };
  });
  expect(metrics.columns).toBe(columns);
  expect(metrics.horizontal).toBeLessThanOrEqual(1);
  expect(metrics.pageHorizontal).toBeLessThanOrEqual(1);
  expect(metrics.offenders).toEqual([]);
  if (noScroll) expect(metrics.vertical, 'Normal desktop forms should fit without scrolling').toBeLessThanOrEqual(1);
  const port = await portGeometry(page);
  if (port.visible) expect(port.textSpace).toBeGreaterThanOrEqual(port.textWidth + 2);
  await expect(page.locator('#modal-close-btn')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#server-submit-btn')).toBeInViewport({ ratio: 1 });
}

test.describe('desktop', () => {
  test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  for (const theme of themes) {
    for (const locale of locales) {
      test(`${theme} / ${locale}: two columns, full five-digit ports and all form modes`, async ({ page }, testInfo) => {
        await page.setViewportSize(locale === 'en-US'
          ? { width: 1280, height: 720 } : { width: 1366, height: 768 });
        await openModal(page, theme, locale);
        await expect(page.locator('#server-port')).toHaveValue('65535');
        expect((await page.locator('.server-modal-panel').boundingBox())!.width).toBeGreaterThan(800);
        await assertLayout(page, 2, true);
        if (locale === 'zh-CN') {
          const path = testInfo.outputPath(`server-modal-${theme}.png`);
          await page.screenshot({ path, animations: 'disabled' });
          await testInfo.attach('desktop-preview', { path, contentType: 'image/png' });
        }
        for (const method of ['password', 'key', 'none', 'cf-ca']) {
          await page.locator(`#modal-auth-tab-${method}`).click();
          await assertLayout(page, 2, true);
        }
        await page.locator('#modal-transport-tab-tunnel').click();
        await expect(page.locator('#server-port-field')).toBeHidden();
        expect(await page.locator('#server-port').evaluate((input) => (input as HTMLInputElement).required)).toBe(false);
        await page.locator('#server-cf-access-toggle').click();
        await page.locator('#modal-auth-tab-key').click();
        await assertLayout(page, 2, true);
        const host = (await page.locator('#server-host-field').boundingBox())!;
        const endpoint = (await page.locator('.ssh-endpoint-fields').boundingBox())!;
        expect(host.width).toBeCloseTo(endpoint.width, 0);
        await page.locator('#modal-transport-tab-direct').click();
        await expect(page.locator('#server-cf-access-section')).toBeHidden();
        await expect(page.locator('#server-port-field')).toBeVisible();
        expect(await page.locator('#server-port').evaluate((input) => (input as HTMLInputElement).required)).toBe(true);
        await assertLayout(page, 2, true);
      });
    }
  }

  for (const theme of themes) {
    test(`${theme}: short windows keep actions visible while only fields scroll`, async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 440 });
      await openModal(page, theme, 'en-US', true);
      await page.locator('#modal-auth-tab-key').click();
      await assertLayout(page, 2);
      await page.locator('.server-modal-fields').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.locator('#server-submit-btn')).toBeInViewport({ ratio: 1 });
      await expect(page.locator('#modal-close-btn')).toBeInViewport({ ratio: 1 });
      await page.locator('#modal-close-btn').click();
      await page.locator('#add-server-btn').click();
      expect(await page.locator('.server-modal-fields').evaluate((element) => element.scrollTop)).toBe(0);
      await expect(page.locator('#server-name')).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
      await expect(page.locator('#server-modal')).toBeHidden();
    });
  }
});

test.describe('narrow and touch', () => {
  test.use({ hasTouch: true });
  for (const theme of themes) {
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }]) {
      test(`${theme} / ${viewport.width}: one column without clipped controls`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await openModal(page, theme, 'en-US', true);
        await page.locator('#server-port').fill('45404');
        await assertLayout(page, 1);
        for (const method of ['key', 'none', 'cf-ca']) {
          await page.locator(`#modal-auth-tab-${method}`).click();
          await assertLayout(page, 1);
        }
        await page.locator('#modal-transport-tab-tunnel').click();
        await page.locator('#server-cf-access-toggle').click();
        await assertLayout(page, 1);
        if (theme === 'liquid-glass' && viewport.width === 390) {
          const path = testInfo.outputPath('server-modal-mobile.png');
          await page.screenshot({ path, animations: 'disabled' });
          await testInfo.attach('mobile-preview', { path, contentType: 'image/png' });
        }
        await expect(page.locator('#server-cf-client-id')).toBeEditable();
        await page.locator('#server-cf-client-id').fill('preview.access');
        await page.locator('#server-cf-client-secret').fill('test-only-secret');
        await expect(page.locator('#server-submit-btn')).toBeInViewport({ ratio: 1 });
      });
    }
  }
});

for (const theme of themes) {
  test(`${theme}: anonymous form also shows all five port digits`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.route('**/api/auth/me', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    });
    await page.route('**/api/config', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ json: {
        authMode: 'anonymous', turnstileEnabled: false, githubAuthEnabled: false, githubAuthRequired: false,
      } });
    });
    await page.addInitScript((value) => localStorage.setItem('cloudssh_theme_selection', value), theme);
    await page.goto('/?lang=en-US');
    await page.locator('#port').fill('65535');
    await page.evaluate(() => document.fonts.ready);
    const port = await portGeometry(page, '#port');
    expect(port.textSpace).toBeGreaterThanOrEqual(port.textWidth + 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });
}

test('five-digit ports keep native bounds and save numeric values in add/edit flows', async ({ page }) => {
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/api/servers/1', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ json: { ...savedServer, ...body } });
  });
  await openModal(page, 'liquid-glass');
  for (const value of ['0', '65536', '22.5', '']) {
    await page.locator('#server-port').fill(value);
    expect(await page.locator('#server-port').evaluate((input) => (input as HTMLInputElement).validity.valid)).toBe(false);
    await page.locator('#server-submit-btn').click();
    expect(requests).toHaveLength(0);
  }
  await page.locator('#server-port').fill('65535');
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].port).toBe(65535);
  await page.locator('#add-server-btn').click();
  await page.locator('#server-name').fill('Five digit port');
  await page.locator('#server-host').fill('ssh.example.com');
  await page.locator('#server-username').fill('deploy');
  await page.locator('#server-port').fill('45404');
  await page.route('**/api/servers', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({ status: 201, json: { ...savedServer, ...body, id: 2 } });
  });
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].port).toBe(45404);
});

test('custom spacious theme at maximum typography scale preserves controls and scroll fallback', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route('**/api/user/theme', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { theme: {
      schemaVersion: 4, name: 'Large Controls', baseTheme: 'standard-dark', colorScheme: 'dark',
      appearance: { style: 'soft', density: 'spacious', font: 'mono', components: { input: 'boxed' } },
      typography: { fontScale: 1.25, radiusScale: 2 },
    } } });
  });
  await page.goto('/?lang=en-US');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'spacious');
  await page.locator('#edit-1').click();
  await page.evaluate(() => document.fonts.ready);
  await assertLayout(page, 2);
  await page.locator('#modal-auth-tab-key').click();
  await assertLayout(page, 2);
  await page.setViewportSize({ width: 320, height: 568 });
  await assertLayout(page, 1);
  await page.locator('#modal-transport-tab-tunnel').click();
  await page.locator('#server-cf-access-toggle').click();
  await assertLayout(page, 1);
});
