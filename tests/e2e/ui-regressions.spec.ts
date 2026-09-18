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

/**
 * Liquid Glass 下 .cyber-box 的 overflow 简写回归（v2.3.0 缺陷）：
 *
 * 主题规则 `html[data-ui-style="liquid"] :is(.server-card, .cyber-box)` 曾使用
 * `overflow: hidden` 简写。它会同时把 overflow-x / overflow-y 置为 hidden，
 * 且特异性高于 Tailwind 的 `.overflow-y-auto`。而 #ai-model-menu（AI 模型下拉）
 * 与 .responsive-modal-panel（AI 设置面板本身）都带 .cyber-box 并依赖滚动，
 * 于是模型列表与面板全部失去滚动能力 —— 445 个模型只能看到前 6 个且无法选择。
 *
 * 本用例以「用户级」方式断言：滚轮悬停在列表上必须真的产生滚动，且滚动后
 * 靠后的模型必须能被点选并写回输入框（仅在断言 overflow-y 计算值之外多一层保障）。
 */
test('Liquid Glass 主题下 AI 模型下拉与设置面板保持可滚动、可选（overflow 简写回归）', async ({
  page,
}) => {
  await blockOptionalThirdPartyAssets(page);
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
        model: 'model-0',
        api_key_last4: '9999',
      }),
    })
  );
  // 模型数量必须足以超出 max-h-52（208px）才会暴露不可滚动的问题
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: Array.from({ length: 60 }, (_, i) => ({ id: `model-${i}` })),
        fallback: false,
      }),
    })
  );

  await page.addInitScript(() => localStorage.setItem('cloudssh_theme_selection', 'liquid-glass'));
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'liquid');

  await page.locator('#ai-config-btn').click();
  await expect(page.locator('#ai-config-modal')).toBeVisible();
  await page.locator('#ai-fetch-models-btn').click();

  const menu = page.locator('#ai-model-menu');
  await expect(menu).toBeVisible();
  const options = menu.locator('#ai-model-options > div');
  await expect(options).toHaveCount(60);

  // 意图锁定：必须保留 Tailwind 的 overflow-y-auto（曾被简写改成 hidden）
  expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  // 面板本身同样依赖 overflow-y-auto 在矮视口下滚动
  expect(
    await page
      .locator('#ai-config-modal .responsive-modal-panel')
      .evaluate((el) => getComputedStyle(el).overflowY)
  ).toBe('auto');

  // 用户级验证：滚轮悬停在列表上必须真的滚动
  const menuBox = (await menu.boundingBox())!;
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // 滚动到靠后位置后，必须能真正点选并写回输入框
  const target = options.nth(40);
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#ai-model')).toHaveValue('model-40');
});

/**
 * 窄视口弹窗不得出现横向滚动条（v2.3.0 后续缺陷）：
 *
 * 模型行里的「获取模型列表」按钮是 shrink-0 + whitespace-nowrap，而
 * #ai-model-combobox 未声明 min-width: 0，因此 flex 行无法收缩，整行比面板宽出
 * 约 80px；而 overflow-y: auto 会使 overflow-x 计算为 auto，于是弹窗底部冒出
 * 原生横向滚动条，并把左侧标签挤出可视区（用户上报的「不美观」）。
 *
 * 修复：面板 overflow-x: hidden + 面板内 .terminal-input { min-width: 0 }
 *   + 模型组合框 min-w-0；滚动条另经全局主题化，不再使用系统原生外观。
 * 同时守护 .no-scrollbar 确实有定义（此前该 class 被引用但从未实现，
 * 导致面包屑/胶囊条等本应隐藏的横向滚动条一直以原生样式出现）。
 */
test('窄视口 AI 设置弹窗不出现横向滚动条，且 .no-scrollbar 已实现', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
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
        base_url: 'https://openrouter.ai/api/v1',
        model: 'gpt-4o-mini',
        api_key_last4: '26b8',
      }),
    })
  );
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        // 长模型名曾把面板撑出横向滚动条
        models: Array.from({ length: 12 }, (_, i) => ({
          id: `deepseek/deepseek-r1-distill-llama-70b-${i}`,
        })),
        fallback: false,
      }),
    })
  );

  await page.addInitScript(() => localStorage.setItem('cloudssh_theme_selection', 'liquid-glass'));
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'liquid');

  const moreBtn = page.locator('#user-space-more-btn');
  if (await moreBtn.isVisible()) await moreBtn.click();
  await page.locator('#ai-config-btn').click();
  await expect(page.locator('#ai-config-modal')).toBeVisible();
  await page.locator('#ai-fetch-models-btn').click();
  await expect(page.locator('#ai-model-menu')).toBeVisible();

  const layout = await page.evaluate(() => {
    const panel = document.querySelector(
      '#ai-config-modal .responsive-modal-panel'
    ) as HTMLElement;
    const menu = document.getElementById('ai-model-menu') as HTMLElement;
    const btn = document.getElementById('ai-fetch-models-btn') as HTMLElement;
    const panelRect = panel.getBoundingClientRect();
    const probe = document.createElement('div');
    probe.className = 'no-scrollbar';
    document.body.appendChild(probe);
    const noScrollbarWidth = getComputedStyle(probe).scrollbarWidth;
    probe.remove();
    return {
      panelHasHScroll: panel.scrollWidth > panel.clientWidth,
      menuHasHScroll: menu.scrollWidth > menu.clientWidth,
      btnInsidePaddingBox: btn.getBoundingClientRect().right <= panelRect.right,
      noScrollbarWidth,
    };
  });

  expect(layout.panelHasHScroll).toBe(false);
  expect(layout.menuHasHScroll).toBe(false);
  expect(layout.btnInsidePaddingBox).toBe(true);
  expect(layout.noScrollbarWidth).toBe('none');
});
