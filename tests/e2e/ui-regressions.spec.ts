import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

test('强制 GitHub 登录模式隐藏匿名连接表单', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: false,
        sitekey: '',
        githubAuthEnabled: true,
        githubAuthRequired: true,
      }),
    })
  );

  await page.goto('/');

  await expect(page.locator('#github-auth-required-panel')).toBeVisible();
  await expect(page.locator('#github-login-btn')).toBeVisible();
  await expect(page.locator('#connection-form')).toHaveCount(0);
});

test('AI 配置首次点击立即显示，配置数据异步加载', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );

  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  await page.route('**/api/ai/config', async (route) => {
    await configGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        base_url: 'https://api.example.com/v1',
        model: 'example-model',
        api_key_last4: '1234',
      }),
    });
  });

  await page.goto('/');
  await page.locator('#ai-config-btn').click();

  await expect(page.locator('#ai-config-modal')).toBeVisible();
  await expect(page.locator('#ai-base-url')).toHaveValue('');

  releaseConfig();
  await expect(page.locator('#ai-base-url')).toHaveValue('https://api.example.com/v1');
  await expect(page.locator('#ai-model')).toHaveValue('example-model');
});

test('AI 模型选择下拉框：免重复输入 token 获取模型列表，且展示完整模型并支持切换与清空', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 42, username: 'testuser', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        base_url: 'https://api.example.com/v1',
        model: 'model-a',
        api_key_last4: '9999',
      }),
    })
  );

  let capturedRequestBody: any = null;
  await page.route('**/api/ai/models', async (route) => {
    capturedRequestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'model-a' },
          { id: 'model-b' },
          { id: 'model-c' },
        ],
        fallback: false,
      }),
    });
  });

  await page.goto('/');
  await page.locator('#ai-config-btn').click();
  await expect(page.locator('#ai-config-modal')).toBeVisible();

  // 验证 API 密钥输入框为空，但显示了掩码提示
  await expect(page.locator('#ai-api-key')).toHaveValue('');
  await expect(page.locator('#ai-key-hint')).toContainText('9999');

  // 用户第二次修改模型时：无需输入 token，直接点击“获取模型列表”
  await page.locator('#ai-fetch-models-btn').click();

  // 验证请求体：无需传 api_key，后端将自动使用已存储的密钥
  expect(capturedRequestBody).toEqual({ base_url: 'https://api.example.com/v1' });

  // 获取成功后，自定义下拉菜单自动展开并展示所有 3 个模型
  const menu = page.locator('#ai-model-menu');
  await expect(menu).toBeVisible();
  const options = menu.locator('#ai-model-options > div');
  await expect(options).toHaveCount(3);

  // 检查 model-b 和 model-c 都在列表中，而不是只显示当前选中的 1 个模型
  await expect(options.nth(0)).toContainText('model-a');
  await expect(options.nth(1)).toContainText('model-b');
  await expect(options.nth(2)).toContainText('model-c');

  // 点击选择 model-b
  await options.nth(1).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#ai-model')).toHaveValue('model-b');

  // 点击清空按钮
  await page.locator('#ai-model-clear-btn').click();
  await expect(page.locator('#ai-model')).toHaveValue('');
  // 清空后下拉菜单重新展开完整模型列表
  await expect(menu).toBeVisible();
  await expect(options).toHaveCount(3);

  // 点击下拉箭头按钮切换折叠
  await page.locator('#ai-model-dropdown-btn').click();
  await expect(menu).toBeHidden();
});

test('Turnstile 跟随 Standard Light 和后续主题切换', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cloudssh_theme_selection', 'standard-light');

    const state = {
      renders: [] as Array<{ id: string; theme: string | undefined }>,
      removals: [] as string[],
    };
    (window as any).__turnstileTest = state;
    (window as any).turnstile = {
      render(container: HTMLElement, options: { theme?: string }) {
        const id = `widget-${state.renders.length + 1}`;
        state.renders.push({ id, theme: options.theme });
        container.replaceChildren(document.createTextNode(id));
        return id;
      },
      remove(widgetId: string) {
        state.removals.push(widgetId);
      },
      reset() {},
      getResponse() {
        return undefined;
      },
    };
  });
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: true,
        sitekey: 'test-site-key',
        githubAuthEnabled: false,
        githubAuthRequired: false,
      }),
    })
  );

  await page.goto('/');

  await expect
    .poll(() => page.evaluate(() => (window as any).__turnstileTest.renders))
    .toEqual([{ id: 'widget-1', theme: 'light' }]);

  await page.evaluate(() => {
    const themeSelector = document.getElementById('theme-selector');
    if (!(themeSelector instanceof HTMLSelectElement)) {
      throw new Error('theme-selector not found');
    }
    themeSelector.value = 'standard-dark';
    themeSelector.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect
    .poll(() => page.evaluate(() => (window as any).__turnstileTest))
    .toEqual({
      renders: [
        { id: 'widget-1', theme: 'light' },
        { id: 'widget-2', theme: 'dark' },
      ],
      removals: ['widget-1'],
    });
});
