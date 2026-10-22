import AxeBuilder from '@axe-core/playwright';
import { APP_VERSION, VERSION_CHANGELOG_URL, VERSION_CHECK_INTERVAL_MS } from '../../src/version';
import { VERSION_CACHE_KEY, VERSION_DISMISSED_KEY } from '../../frontend/src/version-notice';
import { expect, type Page, test } from './fixtures';

const nextVersion = `${Number(APP_VERSION.split('.')[0]) + 1}.0.0`;
const laterVersion = `${Number(APP_VERSION.split('.')[0]) + 1}.0.1`;
const authNotice = (page: Page) => page.locator('#auth-section [data-version-notice]');

async function mockUpdate(page: Page, latestVersion: unknown): Promise<void> {
  await page.route('**/api/version', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { latestVersion } });
  });
}

for (const width of [320, 390, 614]) {
  for (const locale of ['zh-CN', 'zh-TW', 'en-US']) {
    test(`连接页版本紧随标题，三语与更新提示不挤压操作区：${width}px/${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      let latestVersion: string | null = null;
      await page.route('**/api/version', (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        return route.fulfill({ json: { latestVersion } });
      });
      await page.goto(`/?lang=${locale}`);
      const header = page.locator('.auth-connection-header');
      const notice = header.locator('.auth-connection-heading [data-version-notice]');
      await expect(notice).toHaveText(`v${APP_VERSION}`);
      await expect(authNotice(page)).toHaveCount(1);
      await expect(page.locator('#auth-section main > [data-version-notice]')).toHaveCount(0);

      for (const update of [false, true]) {
        if (update) {
          latestVersion = nextVersion;
          await page.evaluate((key) => localStorage.removeItem(key), VERSION_CACHE_KEY);
          await page.reload();
          await expect(notice.locator('a')).toContainText(nextVersion);
          await expect(notice.getByRole('button')).toBeVisible();
        }
        const layout = await header.evaluate((element) => {
          const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
          const title = rect('.auth-connection-title');
          const version = rect('.version-notice__current');
          const notice = rect('[data-version-notice]');
          const actions = rect('.auth-connection-actions');
          const header = element.getBoundingClientRect();
          return {
            versionAfterTitle: version.left >= title.right,
            sameRow: Math.abs(title.y + title.height / 2 - version.y - version.height / 2) < 3,
            noticeFits: notice.left >= header.left && notice.right <= header.right + 1,
            actionsFit: actions.left >= header.left && actions.right <= header.right + 1,
            overlap: notice.left < actions.right && notice.right > actions.left &&
              notice.top < actions.bottom && notice.bottom > actions.top,
            headerFits: element.scrollWidth <= element.clientWidth + 1,
            pageFits: document.documentElement.scrollWidth <= innerWidth,
          };
        });
        if (!update) {
          expect(layout.versionAfterTitle).toBe(true);
          expect(layout.sameRow).toBe(true);
        }
        expect(layout.noticeFits).toBe(true);
        expect(layout.actionsFit).toBe(true);
        expect(layout.overlap).toBe(false);
        expect(layout.headerFits).toBe(true);
        expect(layout.pageFits).toBe(true);
        await expect(header.locator('[data-language-toggle]')).toBeVisible();
      }
    });
  }
}

test('强制登录页的标题版本徽标在四款主题下可读，更新仍可忽略', async ({ page }) => {
  await mockUpdate(page, nextVersion);
  await page.route('**/api/config', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: {
      turnstileEnabled: false,
      sitekey: '',
      githubAuthEnabled: true,
      githubAuthRequired: true,
      authMode: 'github',
    } });
  });
  await page.goto('/?lang=zh-CN');
  for (const theme of ['standard-dark', 'standard-light', 'cyberpunk', 'liquid-glass']) {
    await page.evaluate((theme) => localStorage.setItem('cloudssh_theme_selection', theme), theme);
    await page.reload();
    await expect(page.locator('#host')).toHaveCount(0);
    const notice = page.locator('.auth-connection-header [data-version-notice]');
    await expect(notice.locator('.version-notice__current')).toHaveText(`v${APP_VERSION}`);
    await expect(notice.locator('a')).toBeVisible();
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    });
    const result = await new AxeBuilder({ page }).include('.auth-version-notice').analyze();
    expect(result.violations, theme).toEqual([]);
  }
  await authNotice(page).getByRole('button').click();
  await expect(authNotice(page)).toHaveText(`v${APP_VERSION}`);
});

test('检测不阻塞表单、不抢焦点；提示只打开固定更新日志', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let checks = 0;
  await page.route('**/api/version', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    checks++;
    await gate;
    await route.fulfill({ json: { latestVersion: nextVersion } });
  });
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  await page.goto('/?lang=zh-CN');
  await page.locator('#host').fill('ssh.example.com');
  await expect(page.locator('#host')).toBeFocused();
  await expect(authNotice(page)).toContainText(`v${APP_VERSION}`);
  release();
  const link = authNotice(page).locator('a');
  await expect(link).toHaveText(`新版 v${nextVersion}`);
  await expect(link).toHaveAttribute('href', VERSION_CHANGELOG_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('#host')).toBeFocused();
  await expect(page.locator('#host')).toHaveValue('ssh.example.com');
  await expect(page.locator('.app-toast')).toHaveCount(0);
  expect(dialogs).toEqual([]);
  expect(checks).toBe(1);
  // Reloads reuse the cached result, without hitting the update API again.
  await page.reload();
  await expect(authNotice(page).locator('a')).toBeVisible();
  expect(checks).toBe(1);
});

test('忽略仅针对该新版，刷新保留，下个新版再次提示', async ({ page }) => {
  let latestVersion = nextVersion;
  await page.route('**/api/version', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { latestVersion } });
  });
  await page.goto('/?lang=zh-CN');
  await authNotice(page).getByRole('button', { name: '忽略此版本更新' }).click();
  await expect(authNotice(page).locator('a')).toHaveCount(0);
  await expect(authNotice(page)).toHaveText(`v${APP_VERSION}`);
  await page.reload();
  await expect(page.locator('#host')).toBeVisible();
  await expect(authNotice(page).locator('a')).toHaveCount(0);
  latestVersion = laterVersion;
  await page.evaluate((key) => localStorage.removeItem(key), VERSION_CACHE_KEY);
  await page.reload();
  await expect(authNotice(page).locator('a')).toContainText(laterVersion);
});

for (const latestVersion of [APP_VERSION, '0.1.0', `${nextVersion}-beta.1`, null, '<img src=x onerror=alert(1)>']) {
  test(`相同、旧版、预发布或无效版本不提示：${latestVersion}`, async ({ page }) => {
    await mockUpdate(page, latestVersion);
    await page.goto('/?lang=en-US');
    await expect(page.locator('#host')).toBeVisible();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), VERSION_CACHE_KEY)).not.toBeNull();
    await expect(authNotice(page)).toHaveText(`v${APP_VERSION}`);
    await expect(page.locator('.version-notice__link')).toHaveCount(0);
  });
}

test('网络失败静默降级并退避，不影响表单', async ({ page }) => {
  let checks = 0;
  await page.route('**/api/version', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    checks++;
    return route.abort();
  });
  await page.goto('/?lang=zh-CN');
  await page.locator('#host').fill('ssh.example.com');
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), VERSION_CACHE_KEY)).not.toBeNull();
  await page.reload();
  await expect(page.locator('#host')).toBeVisible();
  await expect(authNotice(page)).toHaveText(`v${APP_VERSION}`);
  await expect(page.locator('.app-toast')).toHaveCount(0);
  expect(checks).toBe(1);
});

test('切换三语时提示同步翻译，不重新检查版本', async ({ page }) => {
  await mockUpdate(page, nextVersion);
  await page.goto('/?lang=zh-CN');
  await expect(authNotice(page).locator('a')).toHaveAttribute('title', /升级可选/);
  await page.locator('#auth-section [data-language-toggle]').click();
  await expect(authNotice(page).locator('a')).toHaveAttribute('title', /升級可選/);
  await page.locator('#auth-section [data-language-toggle]').click();
  await expect(authNotice(page).locator('a')).toHaveText(`New v${nextVersion}`);
  await expect(authNotice(page).getByRole('button')).toHaveAccessibleName('Ignore this version update');
});

test('跨标签页同步忽略状态', async ({ page, context }) => {
  await mockUpdate(page, nextVersion);
  await page.goto('/?lang=zh-CN');
  await expect(authNotice(page).locator('a')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/?lang=zh-CN');
  await expect(authNotice(other).locator('a')).toBeVisible();
  await page.bringToFront();
  await authNotice(page).getByRole('button').click();
  await expect(authNotice(other).locator('a')).toHaveCount(0);
  await other.close();
});

test('存储不可用仍能提示与忽略', async ({ page }) => {
  await page.addInitScript(({ cacheKey, dismissedKey }) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === cacheKey || key === dismissedKey) throw new Error('storage disabled');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === cacheKey || key === dismissedKey) throw new Error('storage disabled');
      return set.call(this, key, value);
    };
  }, { cacheKey: VERSION_CACHE_KEY, dismissedKey: VERSION_DISMISSED_KEY });
  await mockUpdate(page, nextVersion);
  await page.goto('/?lang=zh-CN');
  await expect(authNotice(page).locator('a')).toBeVisible();
  await authNotice(page).getByRole('button').click();
  await expect(authNotice(page).locator('a')).toHaveCount(0);
  await expect(page.locator('#host')).toBeVisible();
});

test('可见长驻页面缓存到期后重新检查，不刷新页面', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(({ key, version, ttl }) => {
    localStorage.setItem(key, JSON.stringify({ checkedAt: Date.now() - ttl + 60_000, latestVersion: version }));
  }, { key: VERSION_CACHE_KEY, version: APP_VERSION, ttl: VERSION_CHECK_INTERVAL_MS });
  await mockUpdate(page, nextVersion);
  await page.goto('/?lang=zh-CN');
  await expect(authNotice(page)).toHaveText(`v${APP_VERSION}`);
  await page.locator('#host').fill('still-editing.example.com');
  await page.clock.fastForward(60_001);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(authNotice(page).locator('a')).toContainText(nextVersion);
  await expect(page.locator('#host')).toHaveValue('still-editing.example.com');
});

test('320px 用户空间页脚与内置主题兼容，不产生横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mockUpdate(page, nextVersion);
  await page.route('**/api/auth/me', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { id: 1, github_id: -1, username: 'admin', avatar_url: null } });
  });
  await page.route('**/api/servers', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { servers: [] } });
  });
  for (const theme of ['standard-dark', 'standard-light', 'cyberpunk', 'liquid-glass']) {
    await page.goto('/?lang=en-US');
    await page.evaluate((theme) => localStorage.setItem('cloudssh_theme_selection', theme), theme);
    await page.reload();
    const footer = page.locator('.user-space-footer');
    await expect(footer.locator('.version-notice__link')).toBeVisible();
    const bounds = await footer.locator('[data-version-notice]').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Check settled theme colors, not the dark→light interpolation during initial mount.
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    });
    const results = await new AxeBuilder({ page })
      .include('.user-space-footer [data-version-notice]')
      .analyze();
    expect(results.violations, theme).toEqual([]);
  }
});

test('移动终端提示在更多菜单中，忽略不中断连接或输入', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockUpdate(page, nextVersion);
  await page.route('**/api/known-hosts?**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
  });
  let connections = 0;
  const inputs: string[] = [];
  await page.routeWebSocket('**/api/ssh*', (socket) => {
    connections++;
    socket.onMessage((data) => {
      if (typeof data !== 'string' || !data.startsWith('{')) {
        inputs.push(data.toString());
        return;
      }
      const message = JSON.parse(data);
      if (message.host) {
        socket.send(JSON.stringify({ type: 'status', event: 'shell_ready' }));
      } else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', id: message.id }));
      }
    });
  });
  await page.goto('/?lang=zh-CN');
  await page.locator('#host').fill('ssh.example.com');
  await page.locator('#username').fill('test');
  await page.locator('#auth-tab-none').click();
  await page.locator('#connect-btn').click();
  await expect(page.locator('#terminal-section')).toBeVisible();
  await expect(page.locator('.terminal-footer')).toBeHidden();
  await page.locator('#mobile-more-btn').click();
  const notice = page.locator('#mobile-more-menu [data-version-notice]');
  await expect(notice.locator('a')).toContainText(nextVersion);
  await notice.getByRole('button').click();
  await expect(notice.locator('a')).toHaveCount(0);
  await expect(page.locator('#terminal-section')).toBeVisible();
  await page.locator('.xterm-helper-textarea').press('x');
  await expect.poll(() => inputs.join('')).toContain('x');
  expect(connections).toBe(1);
});
