import { APP_BOOTSTRAP_TIMEOUT_MS } from '../../frontend/src/app-bootstrap';
import { expect, test, type Page } from './fixtures';

const baseConfig = {
  turnstileEnabled: false, sitekey: '', githubAuthEnabled: false,
  githubAuthRequired: false, authMode: 'anonymous',
};
const user = { id: 1, github_id: 42, username: 'tester', avatar_url: null };

function gate() {
  let release!: () => void;
  let requested!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const seen = new Promise<void>(resolve => { requested = resolve; });
  return { release, requested, waiting, seen };
}

async function observeFormCreation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __bootFormsCreated: number };
    state.__bootFormsCreated = 0;
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          state.__bootFormsCreated += Number(node.matches('#connection-form'));
          state.__bootFormsCreated += node.querySelectorAll('#connection-form').length;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function formsCreated(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as typeof window & { __bootFormsCreated: number }).__bootFormsCreated
  );
}

async function expectPending(page: Page): Promise<void> {
  await expect(page.locator('#app-loading-status')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#app')).toHaveAttribute('inert', '');
  await expect(page.locator('#app')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#connection-form')).toHaveCount(0);
}

test('initial HTML is safe before the application script finishes loading', async ({ page }) => {
  const scriptGate = gate();
  await page.route('**/src/main.ts', async route => {
    scriptGate.requested();
    await scriptGate.waiting;
    await route.fallback();
  });
  await page.goto('/', { waitUntil: 'commit' });
  await scriptGate.seen;
  await expectPending(page);
  expect(await page.evaluate(() => {
    const app = document.getElementById('app')!;
    return document.querySelector('.app-background')?.parentElement === app.parentElement &&
      document.getElementById('app-loading')?.parentElement === app.parentElement;
  })).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() =>
    document.getElementById('app')?.contains(document.activeElement)
  )).toBe(false);
  scriptGate.release();
  await expect(page.locator('#connection-form')).toBeVisible();
});

for (const mode of ['github', 'password'] as const) {
  for (const lastRead of ['config', 'me'] as const) {
    test(`${mode}: no anonymous flash, ${lastRead} last, refresh included`, async ({ page }) => {
      await observeFormCreation(page);
      let configGate = gate();
      let meGate = gate();
      const counts = { config: 0, me: 0 };
      await page.route('**/api/config', async route => {
        if (route.request().method() !== 'GET') return route.fallback();
        counts.config++;
        configGate.requested();
        await configGate.waiting;
        await route.fulfill({ json: {
          ...baseConfig, authMode: mode, githubAuthRequired: true,
          githubAuthEnabled: mode === 'github',
          passwordAuth: { kdf: 'pbkdf2', iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
        } });
      });
      await page.route('**/api/auth/me', async route => {
        if (route.request().method() !== 'GET') return route.fallback();
        counts.me++;
        meGate.requested();
        await meGate.waiting;
        await route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
      });

      for (let navigation = 0; navigation < 2; navigation++) {
        if (navigation === 0) await page.goto('/');
        else await page.reload();
        // Both requests must start before either is released: no serialized network wait.
        await Promise.all([configGate.seen, meGate.seen]);
        await expectPending(page);
        const bounds = await page.locator('#app-loading .cyber-box').boundingBox();
        const firstResponse = page.waitForResponse(
          `**/api/${lastRead === 'config' ? 'auth/me' : 'config'}`
        );
        (lastRead === 'config' ? meGate : configGate).release();
        await firstResponse;
        await expectPending(page);
        expect(await page.locator('#app-loading .cyber-box').boundingBox()).toEqual(bounds);
        (lastRead === 'config' ? configGate : meGate).release();
        const panel = mode === 'github' ? 'github' : 'admin';
        await expect(page.locator(`#${panel}-auth-required-panel`)).toBeVisible();
        await expect(page.locator('#app-loading')).toHaveCount(0);
        await expect(page.locator('#app')).not.toHaveAttribute('inert');
        expect(await formsCreated(page)).toBe(0);
        expect(counts).toEqual({ config: navigation + 1, me: navigation + 1 });
        configGate = gate();
        meGate = gate();
      }
    });
  }
}

test('signed-in page waits for identity without painting the connection page', async ({ page }) => {
  await observeFormCreation(page);
  const meGate = gate();
  let configReads = 0;
  await page.route('**/api/config', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    configReads++;
    return route.fulfill({ json: baseConfig });
  });
  await page.route('**/api/auth/me', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    meGate.requested();
    await meGate.waiting;
    await route.fulfill({ json: user });
  });
  await page.route('**/api/servers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [] }) : route.fallback());
  await page.goto('/');
  await meGate.seen;
  await expectPending(page);
  meGate.release();
  await expect(page.locator('#user-space-section')).toBeVisible();
  await expect(page.locator('#auth-section')).toBeHidden();
  await expect(page.locator('#app-loading')).toHaveCount(0);
  expect(configReads).toBe(1);
  expect(await formsCreated(page)).toBe(0);
});

const failures = ['config-http', 'config-json', 'config-shape', 'auth-http', 'network'] as const;
for (const failure of failures) {
  test(`${failure} stays on a safe error page; retry uses fresh reads`, async ({ page }) => {
    await observeFormCreation(page);
    let attempts = 0;
    let meReads = 0;
    await page.route('**/api/config', route => {
      if (route.request().method() !== 'GET') return route.fallback();
      attempts++;
      if (attempts > 1) return route.fulfill({ json: baseConfig });
      if (failure === 'network') return route.abort('failed');
      if (failure === 'config-http') return route.fulfill({ status: 503, json: {} });
      if (failure === 'config-json') {
        return route.fulfill({ contentType: 'text/html', body: '<html>Access login</html>' });
      }
      if (failure === 'config-shape') return route.fulfill({ json: {} });
      return route.fulfill({ json: baseConfig });
    });
    await page.route('**/api/auth/me', route => {
      if (route.request().method() !== 'GET') return route.fallback();
      meReads++;
      const status = failure === 'auth-http' && meReads === 1 ? 500 : 401;
      return route.fulfill({ status, json: {} });
    });
    await page.goto('/?lang=en-US');
    await expect(page.locator('#app-loading-error')).toBeVisible();
    await expect(page.locator('#app-loading-status')).toBeHidden();
    await expect(page.locator('#app')).toBeHidden();
    expect(await formsCreated(page)).toBe(0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('#connection-form')).toBeVisible();
    await expect(page.locator('#app-loading')).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(meReads).toBe(2);
  });
}

test('timeout rejects late responses and retry is single-flight', async ({ page }) => {
  await page.clock.install();
  let configReads = 0;
  const stalled = gate();
  const retry = gate();
  await page.route('**/api/config', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const current = ++configReads === 1 ? stalled : retry;
    current.requested();
    await current.waiting;
    await route.fulfill({ json: baseConfig }).catch(() => {});
  });
  await page.goto('/');
  await stalled.seen;
  await expectPending(page);
  await page.clock.fastForward(APP_BOOTSTRAP_TIMEOUT_MS + 1);
  await expect(page.locator('#app-loading-error')).toBeVisible();
  stalled.release();
  await expect(page.locator('#connection-form')).toHaveCount(0);
  await page.locator('#app-loading-retry').click();
  await retry.seen;
  // Programmatic duplicate clicks also cannot start another request pair.
  await page.locator('#app-loading-retry').evaluate((button: HTMLButtonElement) => {
    button.click();
    button.dispatchEvent(new Event('click'));
  });
  expect(configReads).toBe(2);
  await expectPending(page);
  retry.release();
  await expect(page.locator('#connection-form')).toBeVisible();
});

for (const [locale, message, theme] of [
  ['zh-CN', '正在加载配置与登录状态…', 'standard-dark'],
  ['zh-TW', '正在載入設定與登入狀態…', 'standard-light'],
  ['en-US', 'Loading configuration and sign-in status…', 'liquid-glass'],
]) {
  test(`localized, motion-aware loading: ${locale}, ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(
      theme => localStorage.setItem('cloudssh_theme_selection', theme), theme
    );
    const configGate = gate();
    await page.route('**/api/config', async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      configGate.requested();
      await configGate.waiting;
      await route.fulfill({ json: baseConfig });
    });
    await page.goto(`/?lang=${locale}`);
    await configGate.seen;
    await expect(page.locator('#app-loading-status')).toHaveText(message);
    const spinner = page.locator('.app-loading-spinner');
    expect(await spinner.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth - innerWidth
    )).toBeLessThanOrEqual(1);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const motion of ['none', 'reduced']) {
      await page.evaluate(motion => {
        document.documentElement.dataset.uiMotion = motion;
      }, motion);
      expect(await spinner.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    }
    configGate.release();
    await expect(page.locator('#connection-form')).toBeVisible();
  });
}

test('share landing bypasses bootstrap reads and is revealed immediately', async ({ page }) => {
  const reads: string[] = [];
  await page.route(/\/api\/(?:config|auth\/me|version)$/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads.push(route.request().url());
    return route.abort();
  });
  await page.goto(`/#/share/${'a'.repeat(43)}`);
  await expect(page.locator('#share-claim-btn')).toBeVisible();
  await expect(page.locator('#app-loading')).toHaveCount(0);
  expect(reads).toEqual([]);
});

test('password setup remains usable even if configuration is unavailable', async ({ page }) => {
  await page.route('**/api/config', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 503, json: {} }) : route.fallback());
  await page.goto('/?lang=en-US#password-setup');
  await expect(page.locator('#admin-hash-password')).toBeVisible();
  await expect(page.locator('#app-loading-error')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
});
