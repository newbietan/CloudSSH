import { expect, test, type Page } from './fixtures';
import { blockOptionalThirdPartyAssets } from './helpers';
import { mockThemeLibrary } from './theme-mocks';

const background = '.app-background';
const phases = [0, 8750, 17500, 35000, 52500, 70000];

async function mockSavedServers(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } });
  });
  await page.route('**/api/servers', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        user_id: 1,
        name: `Glass Preview ${index + 1}`,
        host: 'preview.example.com',
        port: 22,
        username: 'tester',
        auth_method: 'publickey',
        region: null,
        inferred_hint: 'apac',
        tags: ['preview'],
        created_at: '',
        updated_at: '',
      })),
    });
  });
}

async function freezeAnimations(page: Page, time: number): Promise<void> {
  await page.evaluate((time) => {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = time;
      } else {
        animation.finish();
      }
    }
  }, time);
}

// Decode screenshots in the browser: no platform-specific snapshots or new PNG dependencies.
async function imageDifference(page: Page, actual: Buffer, expected: Buffer) {
  return page.evaluate(async ({ actual, expected }) => {
    const images = await Promise.all([actual, expected].map(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      return image;
    }));
    const canvas = document.createElement('canvas');
    canvas.width = images[0].width;
    canvas.height = images[0].height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const pixels = images.map((image) => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    });
    let sum = 0;
    let max = 0;
    for (let index = 0; index < pixels[0].length; index++) {
      if (index % 4 === 3) continue;
      const difference = Math.abs(pixels[0][index] - pixels[1][index]);
      sum += difference;
      max = Math.max(max, difference);
    }
    return { max, mean: sum / (canvas.width * canvas.height * 3) };
  }, { actual: actual.toString('base64'), expected: expected.toString('base64') });
}

test.beforeEach(async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.addInitScript(() => {
    if (localStorage.getItem('cloudssh_theme_selection') === null) {
      localStorage.setItem('cloudssh_theme_selection', 'liquid-glass');
    }
  });
});

test('背景独立裁剪，保留 35s 往返缓动和 30% 视口位移，关键帧仅包含 transform', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#host')).toBeVisible();
  const layer = page.locator(background);
  await expect(layer).toHaveAttribute('aria-hidden', 'true');
  await expect(layer).toHaveCSS('position', 'fixed');
  await expect(layer).toHaveCSS('overflow', 'hidden');
  await expect(layer).toHaveCSS('pointer-events', 'none');
  await expect(layer).toHaveCSS('z-index', '-1');

  const contract = await layer.evaluate((element) => {
    const animation = document.getAnimations().find((item) =>
      item instanceof CSSAnimation && item.animationName === 'theme-bg-drift'
    )!;
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect)) throw new Error('Missing background keyframes');
    const timing = effect.getTiming();
    const properties = effect.getKeyframes().map((frame) => Object.keys(frame).filter(
      (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)
    ));
    return {
      duration: timing.duration,
      direction: timing.direction,
      infinite: timing.iterations === Infinity,
      easing: getComputedStyle(element, '::before').animationTimingFunction,
      properties,
      independent: element.parentElement === document.body && !element.contains(document.getElementById('app')),
    };
  });
  expect(contract).toEqual({
    duration: 35000,
    direction: 'alternate',
    infinite: true,
    easing: 'ease-in-out',
    properties: [['transform'], ['transform']],
    independent: true,
  });

  for (const time of [0, 35000, 70000]) {
    await freezeAnimations(page, time);
    const geometry = await layer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element, '::before');
      const matrix = new DOMMatrix(style.transform);
      return { width: rect.width, height: rect.height, imageWidth: parseFloat(style.width),
        imageHeight: parseFloat(style.height), x: matrix.m41, y: matrix.m42 };
    });
    expect(geometry.imageWidth).toBeCloseTo(geometry.width * 1.3 + 1, 1);
    expect(geometry.imageHeight).toBeCloseTo(geometry.height * 1.3 + 1, 1);
    expect(geometry.x).toBeCloseTo(time === 35000 ? -geometry.width * 0.3 : 0, 1);
    expect(geometry.y).toBeCloseTo(time === 35000 ? -geometry.height * 0.3 : 0, 1);
  }
});

for (const scene of ['auth', 'servers'] as const) {
  test(`${scene}：六个往返动画时刻与旧渲染逐帧对照，不减少玻璃滤镜、光晕或阴影`, async ({ page }, testInfo) => {
    if (scene === 'servers') await mockSavedServers(page);
    await page.goto('/');
    await expect(page.locator(scene === 'servers' ? '.server-card' : '#host').first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'liquid');
    await expect(page.locator('html')).toHaveAttribute('data-fx-glow', 'on');
    const glass = page.locator(scene === 'servers' ? '.server-card' : '#auth-section .cyber-box').first();
    const originalFilter = await glass.evaluate((element) => getComputedStyle(element).backdropFilter);
    expect(originalFilter).toBe('blur(20px) saturate(1.9) contrast(1.12) brightness(1.06)');

    const frames: Buffer[] = [];
    for (const time of phases) {
      await freezeAnimations(page, time);
      frames.push(await page.screenshot());
    }

    // Test-only reference implementation. Never disable/replace the glass material itself.
    await page.addStyleTag({ content: `
      .app-background { display: none !important; }
      body::before {
        content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
        background-image: var(--app-bg-stack, none); background-size: 130% 130%;
        animation: legacy-theme-bg-drift 35s ease-in-out infinite alternate;
      }
      @keyframes legacy-theme-bg-drift {
        from { background-position: 0% 0%; }
        to { background-position: 100% 100%; }
      }
    ` });
    for (const [index, time] of phases.entries()) {
      await freezeAnimations(page, time);
      const expected = await page.screenshot();
      const difference = await imageDifference(page, frames[index], expected);
      if (difference.max > 8 || difference.mean > 0.75) {
        await testInfo.attach(`compositor-${time}`, { body: frames[index], contentType: 'image/png' });
        await testInfo.attach(`legacy-${time}`, { body: expected, contentType: 'image/png' });
      }
      // Small subpixel/raster sampling differences are expected; material or layout changes are not.
      expect(difference.max, `phase ${time}ms`).toBeLessThanOrEqual(8);
      expect(difference.mean, `phase ${time}ms`).toBeLessThanOrEqual(0.75);
    }
    await expect(glass).toHaveCSS('backdrop-filter', originalFilter);
  });
}

test('视口缩放和页面滚动不会改变背景覆盖范围或产生横向滚动', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#host')).toBeVisible();
  for (const viewport of [{ width: 391, height: 843 }, { width: 913, height: 667 }]) {
    await page.setViewportSize(viewport);
    await freezeAnimations(page, 35000);
    await page.evaluate(() => {
      document.body.style.minHeight = '2200px';
      window.scrollTo(0, 120);
    });
    const geometry = await page.locator(background).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth, scrollY: window.scrollY };
    });
    expect(geometry.scrollY).toBeGreaterThan(0);
    expect(geometry.x).toBe(0);
    expect(geometry.y).toBe(0);
    expect(geometry.width).toBe(geometry.clientWidth);
    expect(geometry.height).toBe(geometry.clientHeight);
    expect(geometry.scrollWidth).toBe(geometry.clientWidth);
  }
});

test('系统减少动态与 motion=none 保持原来的静止背景，恢复后继续使用合成动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#host')).toBeVisible();
  const animationName = () => page.locator(background).evaluate((element) =>
    getComputedStyle(element, '::before').animationName
  );
  await expect.poll(animationName).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(animationName).toBe('theme-bg-drift');
  await page.evaluate(() => { document.documentElement.dataset.uiMotion = 'none'; });
  await expect.poll(animationName).toBe('none');
  await page.evaluate(() => { document.documentElement.dataset.uiMotion = 'full'; });
  await expect.poll(animationName).toBe('theme-bg-drift');
});

test('切换纯色/静态渐变/漂移主题不残留动画或背景，始终只保留一个装饰层', async ({ page }) => {
  await mockSavedServers(page);
  await page.goto('/');
  const selector = page.locator('#user-theme-selector');
  const state = () => page.locator(background).evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    return { animation: style.animationName, transform: style.transform, image: style.backgroundImage };
  });
  await expect(page.locator('.server-card').first()).toBeVisible();
  for (const theme of ['cyberpunk', 'standard-light', 'liquid-glass', 'standard-dark', 'liquid-glass']) {
    // The mobile menu hides this select; dispatch through its real change handler on both layouts.
    await selector.selectOption(theme, { force: true });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator(background)).toHaveCount(1);
    const current = await state();
    if (theme === 'liquid-glass') {
      expect(current.animation).toBe('theme-bg-drift');
      expect(current.image).toContain('radial-gradient');
    } else {
      expect(current.animation).toBe('none');
      expect(current.transform).toBe('none');
      if (theme === 'cyberpunk') expect(current.image).toContain('linear-gradient');
      else expect(current.image).toBe('none');
    }
  }
});

test('云端自定义背景沿用渐变/遮罩/噪点配置，并遵守导入的 motion=none', async ({ page }) => {
  // An explicit built-in local choice intentionally takes precedence over the cloud theme.
  await page.addInitScript(() => localStorage.setItem('cloudssh_theme_selection', '__custom__'));
  await mockSavedServers(page);
  await mockThemeLibrary(page, {
    methods: ['GET'],
    activeId: 'cth_background',
    themes: [{
      id: 'cth_background', name: 'Custom Background', createdAt: 1,
      data: {
        schemaVersion: 4, name: 'Custom Background', baseTheme: 'standard-dark', colorScheme: 'dark',
        ui: { '--accent': '#67e8f9' },
        appearance: { style: 'standard', motion: 'none' },
        background: { type: 'radial', stops: ['#123456', '#654321'], angle: 120, scrim: 0.4, animation: 'drift' },
        effects: { noise: 0.04 },
      },
    }],
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');
  await expect(page.locator('html')).toHaveAttribute('data-bg-animation', 'drift');
  const style = await page.locator(background).evaluate((element) => {
    const background = getComputedStyle(element, '::before');
    const noise = getComputedStyle(document.body, '::after');
    return { image: background.backgroundImage, animation: background.animationName,
      noise: noise.backgroundImage, noiseOpacity: noise.opacity };
  });
  expect(style.image).toContain('radial-gradient');
  expect(style.image).toContain('rgb(18, 52, 86)');
  expect(style.image).toContain('0.4');
  expect(style.animation).toBe('none');
  expect(style.noise).toContain('data:image/svg+xml');
  expect(style.noiseOpacity).toBe('0.04');
});
