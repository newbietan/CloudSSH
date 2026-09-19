import { expect, test, type Page } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

/**
 * 终端顶栏抽屉分段切换器回归：
 *
 * 1. PC 端不得泄露移动端“更多操作”按钮（`#mobile-more-btn`）。
 *    历史缺陷：`html[data-ui-style="liquid"] .terminal-header-actions > button` 的
 *    `display: inline-flex` 特异性高于 `.mobile-only { display: none }`，
 *    导致该按钮在桌面端被强制显示。选择器必须保留 `:not(.mobile-only)`。
 * 2. 抽屉分段胶囊需要可辨识的边缘（描边 + 凹槽阴影），否则在浅色玻璃底上完全糊在一起。
 * 3. SFTP / 自定义命令 / AI Agent 三个抽屉必须共用同一宽度来源
 *    （此前各自内联声明 420–600px 与 440–680px，同屏下宽度明显不一致）。
 */

const WS_URL = encodeURIComponent('ws://127.0.0.1:4173/fake');

async function openTerminalTab(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' })
  );
  await page.goto(`/?wsUrl=${WS_URL}&name=DrawerPreview&host=127.0.0.1&port=22&lang=zh-CN`);
  // 顶栏在桌面端与移动端都存在；分段条本身是 desktop-only，不能作为等待条件
  await expect(page.locator('.terminal-app-header')).toBeVisible();
}

test.describe('桌面视口', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('PC 端不显示移动端更多操作按钮', async ({ page }) => {
    await openTerminalTab(page);

    await expect(page.locator('#mobile-more-btn')).toBeHidden();
    await expect(page.locator('#mobile-more-menu')).toBeHidden();
    // 同屏的桌面端操作按钮必须照常可见，避免“一刀切隐藏”式的假通过
    await expect(page.locator('#search-btn')).toBeVisible();
    await expect(page.locator('#export-btn')).toBeVisible();
    await expect(page.locator('#disconnect-btn')).toBeVisible();
  });

  test('抽屉分段胶囊具备可见边缘与明确标签', async ({ page }) => {
    await openTerminalTab(page);

    const bar = page.locator('#terminal-drawer-segmented-bar');
    await expect(bar).toBeVisible();

    const shape = await bar.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        radius: style.borderRadius,
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor,
        shadow: style.boxShadow,
      };
    });

    expect(shape.radius).toBe('9999px');
    expect(shape.borderWidth).toBe('1px');
    // 边缘必须真实可见：边框不能是透明，且至少有一层投影/描边
    expect(shape.borderColor).not.toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/);
    expect(shape.shadow).not.toBe('none');

    // 标签必须浅显易懂，不能再用含糊的“片段”
    const snippetLabel = page.locator('#snippet-toggle-btn .drawer-btn-label');
    await expect(snippetLabel).toHaveAttribute('data-i18n', 'terminal.drawer.snippets');
    await expect(snippetLabel).toHaveText('自定义命令');
    await expect(page.locator('#sftp-toggle-btn .drawer-btn-label')).toHaveText('SFTP');
    await expect(page.locator('#agent-toggle-btn .drawer-btn-label')).toHaveText('Agent');

    // 匿名终端模式下：AI Agent 功能不可用，按钮必须在视觉上完全隐藏（display: none）
    await expect(page.locator('#agent-toggle-btn')).toBeHidden();
    await expect(page.locator('#sftp-toggle-btn')).toBeVisible();
    await expect(page.locator('#snippet-toggle-btn')).toBeVisible();
  });

  test('登录状态下抽屉分段条显示 AI Agent 按钮', async ({ page }) => {
    await blockOptionalThirdPartyAssets(page);
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, github_id: 42, username: 'tester', avatar_url: '' }),
      })
    );
    await page.route('**/api/servers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );
    await page.goto('/?lang=zh-CN');
    await expect(page.locator('#user-space-section')).toBeVisible();

    // 登录后解除 hidden
    await expect(page.locator('#agent-toggle-btn')).not.toHaveClass(/hidden/);

    // 切到终端视图后，分段条内 AI Agent 按钮真实可见
    await page.evaluate(async () => {
      const main = await (window as any).eval("import('/src/main.ts')");
      main.showTerminalWithNewTab('TestServer');
    });

    const bar = page.locator('#terminal-drawer-segmented-bar');
    await expect(bar).toBeVisible();
    await expect(page.locator('#sftp-toggle-btn')).toBeVisible();
    await expect(page.locator('#snippet-toggle-btn')).toBeVisible();
    await expect(page.locator('#agent-toggle-btn')).toBeVisible();
  });

  test('三个侧边抽屉共用同一宽度来源', async ({ page }) => {
    await openTerminalTab(page);

    const widths = await page.evaluate(async () => {
      const agentModule = await (window as any).eval("import('/src/agent/agent-panel.ts')");
      const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
      const snippetModule = await (window as any).eval("import('/src/snippet-manager.ts')");

      const agent = new agentModule.AgentPanel(document.getElementById('terminal-area')!, true);
      agent.show();

      const sftp = new sftpModule.SFTPPanel(() => null);
      sftp.visible = true;

      const snippets = new snippetModule.SnippetManager({
        getTerminal: () => null,
        isAuthenticated: () => false,
      });
      await snippets.open();

      const widthOf = (id: string): number =>
        Math.round(document.getElementById(id)!.getBoundingClientRect().width);

      return {
        agent: widthOf('agent-panel'),
        sftp: widthOf('sftp-panel'),
        snippet: widthOf('snippet-panel'),
      };
    });

    // 1280 视口：min(clamp(420px, 40vw, 600px), 100vw) === 512px
    expect(widths).toEqual({ agent: 512, sftp: 512, snippet: 512 });
  });

  test('点击抽屉按钮时液态透镜滑块出现，收起时泊位', async ({ page }) => {
    await openTerminalTab(page);

    const snippetBtn = page.locator('#snippet-toggle-btn');
    const lens = page.locator('.drawer-segmented-lens');

    // 初始未打开任何抽屉：透镜隐藏
    await expect(snippetBtn).toHaveAttribute('aria-selected', 'false');
    expect(await lens.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

    await snippetBtn.click();

    // 透镜需真实出现且具有非零宽度（= 弹簧已驱动到目标位置）
    await expect(snippetBtn).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => lens.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect
      .poll(async () =>
        lens.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 8 && el.style.transform.startsWith('translateX');
        })
      )
      .toBe(true);

    // 再次点击当前激活按钮：抽屉与透镜一起泊位
    await snippetBtn.click();
    await expect(snippetBtn).toHaveAttribute('aria-selected', 'false');
    await expect.poll(async () => lens.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  });
});

test.describe('移动端视口', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('窄屏触控设备保留更多操作入口且隐藏桌面分段条', async ({ page }) => {
    await openTerminalTab(page);

    await expect(page.locator('#mobile-more-btn')).toBeVisible();
    await expect(page.locator('#terminal-drawer-segmented-bar')).toBeHidden();
  });
});