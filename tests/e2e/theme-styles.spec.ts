import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

const server = {
  id: 1,
  user_id: 1,
  name: 'Theme Preview',
  host: 'preview.example.com',
  port: 22,
  username: 'tester',
  auth_method: 'publickey',
  region: null,
  inferred_hint: 'apac',
  tags: ['preview'],
  created_at: '',
  updated_at: '',
};

test.beforeEach(async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: route.request().method() === 'GET' ? '{"theme":null}' : '{"success":true}',
    })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([server]) })
  );
});

test('内置主题切换 UI 风格但保持服务器列表结构稳定', async ({ page }) => {
  await page.goto('/');

  const selector = page.locator('#user-theme-selector');
  const terminalSelector = page.locator('#theme-selector');
  const card = page.locator('.server-card');
  const grid = page.locator('#server-grid');

  await expect(selector).toBeVisible();
  await expect(card).toHaveCount(1);
  await expect(grid).toHaveClass(/grid-cols-1/);

  await selector.selectOption('cyberpunk');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'cyberpunk');
  await expect(card).toHaveCSS('border-radius', '0px');
  await expect(grid).toHaveClass(/md:grid-cols-2/);
  await expect(grid).toHaveClass(/lg:grid-cols-3/);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(selector.locator('option[value="cyberpunk"]')).toHaveCSS(
    'background-color',
    'rgb(19, 19, 19)'
  );
  await expect(selector.locator('option[value="cyberpunk"]')).toHaveCSS(
    'color',
    'rgb(74, 246, 38)'
  );

  // V3：Liquid Glass 内置主题携带背景/效果/模糊与 liquid 风格专属配置
  await selector.selectOption('liquid-glass');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'liquid-glass');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'liquid');
  await expect(page.locator('html')).toHaveAttribute('data-ui-blur', 'strong');
  await expect(page.locator('html')).toHaveAttribute('data-bg-animation', 'drift');
  await expect(page.locator('html')).toHaveAttribute('data-fx-glow', 'on');
  await expect(card).toHaveCSS('border-radius', '21px');
  await expect(terminalSelector).toHaveValue('liquid-glass');
  expect(
    await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)
  ).toContain('radial-gradient');
});

test('云端主题恢复不阻塞用户空间首屏，并避免覆盖加载期间的用户选择', async ({ page }) => {
  let releaseThemeRequest!: () => void;
  const themeRequestGate = new Promise<void>((resolve) => {
    releaseThemeRequest = resolve;
  });
  await page.unroute('**/api/user/theme');
  await page.route('**/api/user/theme', async (route) => {
    await themeRequestGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        theme: {
          schemaVersion: 2,
          name: 'Delayed Theme',
          baseTheme: 'glacier',
          colorScheme: 'dark',
          ui: { '--accent': '#67e8f9' },
          appearance: { style: 'soft', shape: 'soft' },
        },
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('#user-theme-selector')).toBeVisible();
  await expect(page.locator('.server-card')).toHaveCount(1);
  await page.locator('#user-theme-selector').selectOption('standard-light');

  const themeResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/user/theme') && response.request().method() === 'GET'
  );
  releaseThemeRequest();
  await themeResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
      })
  );
  await expect(page.locator('#user-theme-selector')).toHaveValue('standard-light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'standard-light');
});

test('终端四周留白按形状收窄并为圆角保留安全间距', async ({ page }) => {
  const wsUrl = encodeURIComponent('ws://127.0.0.1:4173/fake');
  await page.goto(`/?wsUrl=${wsUrl}&name=ThemePreview&host=127.0.0.1&port=22`);

  const selector = page.locator('#theme-selector');
  const terminalMain = page.locator('.terminal-main');
  const terminalWrapper = page.locator('#terminal-wrapper');

  await selector.selectOption('cyberpunk');
  await expect(terminalMain).toHaveCSS('padding', '4px');
  await expect(terminalWrapper).toHaveCSS('border-radius', '0px');

  await selector.selectOption('standard-dark');
  await expect(terminalMain).toHaveCSS('padding', '7px');
  await expect(terminalWrapper).toHaveCSS('border-radius', '9px');

  await selector.selectOption('liquid-glass');
  await expect(terminalMain).toHaveCSS('padding', '10px');
  await expect(terminalWrapper).toHaveCSS('border-radius', '21px');

  // 打开命令片段抽屉，验证搜索框在 Liquid Glass 下无嵌套边框且搜索图标置顶可见
  await page.locator('#snippet-toggle-btn').click();
  const snippetPanel = page.locator('#snippet-panel');
  await expect(snippetPanel).toBeVisible();
  const searchInput = page.locator('#snippet-search-input');
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveClass(/terminal-input/);
  await expect(searchInput).toHaveCSS('min-height', '34px');
  const searchIcon = snippetPanel.locator('span.material-symbols-outlined:has-text("search")');
  await expect(searchIcon).toBeVisible();
  await expect(searchIcon).toHaveClass(/z-10/);
});

test('应用导入 Theme V2 JSON 后覆盖本地主题并同步账号', async ({ page }) => {
  const themeRequestMethods: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/user/theme')) {
      themeRequestMethods.push(request.method());
    }
  });
  await page.goto('/');

  const customTheme = {
    schemaVersion: 2,
    name: 'Ocean Soft',
    baseTheme: 'glacier',
    colorScheme: 'dark',
    ui: {
      '--accent': '#22d3ee',
      '--bg': '#071827',
    },
    appearance: {
      style: 'soft',
      shape: 'soft',
      density: 'spacious',
      components: {
        button: 'soft',
        input: 'boxed',
        card: 'elevated',
        tabs: 'segmented',
      },
    },
  };

  await page.locator('#import-theme-input').setInputFiles({
    name: 'ocean-soft.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(customTheme)),
  });

  await expect(page.locator('#user-theme-selector')).toHaveValue('__custom__');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'soft');
  await expect(page.locator('html')).toHaveAttribute('data-ui-density', 'spacious');
  await expect.poll(() => themeRequestMethods).toContain('PUT');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('cloudssh_imported_theme')))
    .toContain('Ocean Soft');
  expect(themeRequestMethods).toEqual(expect.arrayContaining(['GET', 'PUT']));
  expect(themeRequestMethods).not.toContain('DELETE');
});

test('新浏览器登录后自动恢复并启用账号中的自定义主题', async ({ page }) => {
  await page.unroute('**/api/user/theme');
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        theme: {
          schemaVersion: 2,
          name: 'Synced Glacier',
          baseTheme: 'glacier',
          colorScheme: 'dark',
          ui: { '--accent': '#67e8f9' },
          appearance: {
            style: 'soft',
            shape: 'soft',
            density: 'comfortable',
            components: { card: 'elevated' },
          },
        },
      }),
    })
  );

  await page.goto('/');

  await expect(page.locator('#user-theme-selector')).toHaveValue('__custom__');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'soft');
  await expect(page.locator('html')).toHaveAttribute('data-component-card', 'elevated');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('cloudssh_theme_selection')))
    .toBe('__custom__');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('cloudssh_imported_theme')))
    .toContain('Synced Glacier');
});

test('Pages 编辑器拒绝超大文件和危险颜色，并在修正后恢复导出', async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  const editorUrl = pathToFileURL(resolve('docs/theme-editor/index.html')).href;

  await page.goto(editorUrl);

  const backgroundInput = page.locator('input[type="text"][data-var="--bg"]');
  const exportButton = page.locator('#btn-export');
  await backgroundInput.fill('url(https://tracker.example/pixel.png)');
  await expect(backgroundInput).toHaveAttribute('aria-invalid', 'true');
  await expect(exportButton).toBeDisabled();
  expect(requestedUrls).not.toContain('https://tracker.example/pixel.png');

  await backgroundInput.fill('#101820');
  await expect(backgroundInput).toHaveAttribute('aria-invalid', 'false');
  await expect(exportButton).toBeEnabled();

  await page.locator('#import-input').setInputFiles({
    name: 'oversized-theme.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(65 * 1024, 0x20),
  });
  await expect(page.locator('.editor-toast')).toContainText('64 KiB');
});

test('AI 模型选择下拉面板在浅色与暗色内置主题下无缝自适应', async ({ page }) => {
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        base_url: 'https://api.example.com/v1',
        model: 'gpt-4o',
        api_key_last4: '8888',
      }),
    })
  );
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [{ id: 'gpt-4o' }, { id: 'claude-3-5-sonnet' }],
        fallback: false,
      }),
    })
  );

  await page.goto('/');

  const userThemeSelector = page.locator('#user-theme-selector');

  // 1. 测试浅色主题 Liquid Glass
  await userThemeSelector.selectOption('liquid-glass');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'liquid-glass');

  await page.locator('#ai-config-btn').click();
  const modal = page.locator('#ai-config-modal');
  await expect(modal).toBeVisible();

  // 获取模型列表并展开下拉
  await page.locator('#ai-fetch-models-btn').click();
  const menu = page.locator('#ai-model-menu');
  await expect(menu).toBeVisible();

  // 验证选项使用主题自适应的类，第一项为选中项（text-primary），第二项为未选中项（text-on-surface）
  const selectedOption = menu.locator('#ai-model-options > div').nth(0);
  const unselectedOption = menu.locator('#ai-model-options > div').nth(1);
  await expect(selectedOption).toBeVisible();
  await expect(selectedOption).toHaveClass(/text-primary/);
  await expect(unselectedOption).toBeVisible();
  await expect(unselectedOption).toHaveClass(/text-on-surface/);

  // 2. 切换暗色主题 Cyberpunk
  await page.locator('#ai-modal-close-btn').click();
  await expect(modal).toBeHidden();

  await userThemeSelector.selectOption('cyberpunk');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'cyberpunk');

  await page.locator('#ai-config-btn').click();
  await expect(modal).toBeVisible();
  await page.locator('#ai-model-dropdown-btn').click();
  await expect(menu).toBeVisible();
  await expect(selectedOption).toBeVisible();
  await expect(unselectedOption).toBeVisible();
});

test('自定义主题分段控制器交互与管理弹窗上传/多套管理/删除回退', async ({ page }) => {
  await page.goto('/');

  // 1. 验证独立上传按钮已被移除
  await expect(page.locator('[data-theme-import]')).toHaveCount(0);

  // 2. 验证分段控制器默认展示 5 个主题按钮
  const customSegmentBtn = page.locator('#user-theme-segmented-container button[data-theme-id="__custom__"]');
  await expect(customSegmentBtn).toBeVisible();
  await expect(page.locator('#user-theme-segmented-container button[data-theme-id]')).toHaveCount(5);

  // 3. 点击自定义主题按钮，未上传过时唤起管理弹窗
  await customSegmentBtn.click();
  const themeModal = page.locator('#custom-theme-modal');
  await expect(themeModal).toBeVisible();
  await expect(themeModal.locator('#custom-theme-dropzone')).toBeVisible();

  // 4. 上传自定义主题
  const customTheme1 = {
    schemaVersion: 4,
    name: 'Neon Horizon',
    baseTheme: 'cyberpunk',
    colorScheme: 'dark',
    ui: {
      '--accent': '#00ffaa',
      '--bg': '#0a0a12',
    },
    appearance: {
      style: 'cyberpunk',
    },
  };

  await themeModal.locator('#custom-theme-file-input').setInputFiles({
    name: 'neon-horizon.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(customTheme1)),
  });

  // 验证列表出现新主题卡片，并且处于激活状态
  await expect(themeModal.locator('#custom-theme-items-container')).toContainText('Neon Horizon');
  await expect(themeModal.locator('#custom-theme-items-container')).toContainText('Active');

  // 关闭弹窗并验证分段控制器选中 Custom
  await themeModal.locator('#custom-theme-modal-close-btn').click();
  await expect(themeModal).toBeHidden();
  await expect(customSegmentBtn).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom');

  // 5. 已经处于 Custom 主题时，再次点击 Custom 按钮打开管理弹窗
  await customSegmentBtn.click();
  await expect(themeModal).toBeVisible();

  // 6. 删除该主题并确认，验证自动回退到内置主题
  await themeModal.locator('#custom-theme-items-container button[title="Delete"]').click();
  await page.locator('.app-dialog__button--confirm').click();

  // 验证弹窗内无主题提示并关闭弹窗
  await expect(themeModal.locator('#custom-theme-items-container')).toContainText('No custom themes yet');
  await themeModal.locator('#custom-theme-modal-close-btn').click();
  await expect(themeModal).toBeHidden();

  // 验证主题回退到内置主题（cyberpunk），Custom 不再处于选中状态
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'cyberpunk');
  await expect(customSegmentBtn).toHaveAttribute('aria-selected', 'false');
});
