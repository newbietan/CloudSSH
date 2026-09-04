import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test.describe('终端标签页重命名与多标签操作', () => {
  test('双击标签页标题可内联重命名', async ({ page }) => {
    await mockAnonymousSession(page);
    await page.goto('/?lang=zh-CN');

    // 建立一个测试标签页
    await page.evaluate(async () => {
      document.getElementById('terminal-section')?.classList.remove('hidden');
      document.getElementById('terminal-section')?.classList.add('flex');
      const tabModule = await (window as any).eval("import('/src/tab-manager.ts')");
      const manager = new tabModule.TabManager('tab-bar', 'terminal-area');
      manager.createTab('Server-Alpha', { host: '192.168.1.10', port: 22 });
      manager.renderTabBar();
      (window as any).__testTabManager = manager;
    });

    const label = page.locator('#tab-bar .tab-label').first();
    await expect(label).toBeVisible();
    await expect(label).toHaveText('Server-Alpha');

    // 双击标签文本触发重命名
    await label.dblclick();

    const input = page.locator('#tab-bar .tab-rename-input');
    await expect(input).toBeVisible();
    await input.fill('Production-DB');
    await input.press('Enter');

    // 重命名完成后文本更新
    await expect(label).toHaveText('Production-DB');
  });

  test('右键标签页弹出上下文菜单', async ({ page }) => {
    await mockAnonymousSession(page);
    await page.goto('/?lang=zh-CN');

    await page.evaluate(async () => {
      document.getElementById('terminal-section')?.classList.remove('hidden');
      document.getElementById('terminal-section')?.classList.add('flex');
      const tabModule = await (window as any).eval("import('/src/tab-manager.ts')");
      const manager = new tabModule.TabManager('tab-bar', 'terminal-area');
      manager.createTab('Server-1', { host: '10.0.0.1', port: 22 });
      manager.createTab('Server-2', { host: '10.0.0.2', port: 22 });
      manager.renderTabBar();
      (window as any).__testTabManager = manager;
    });

    const tabItem = page.locator('#tab-bar .tab-item').first();
    await tabItem.click({ button: 'right' });

    const menu = page.locator('#tab-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('重命名标签页');
    await expect(menu).toContainText('克隆会话');
    await expect(menu).toContainText('关闭其他标签页');

    // 点击“关闭其他标签页”
    await menu.getByText('关闭其他标签页').click();
    await expect(page.locator('#tab-bar .tab-item')).toHaveCount(1);
    await expect(page.locator('#tab-bar .tab-label')).toHaveText('Server-1');
  });

  test('提交空字符串或纯空白时恢复原标签名并不卡死输入框', async ({ page }) => {
    await mockAnonymousSession(page);
    await page.goto('/?lang=zh-CN');

    await page.evaluate(async () => {
      document.getElementById('terminal-section')?.classList.remove('hidden');
      document.getElementById('terminal-section')?.classList.add('flex');
      const tabModule = await (window as any).eval("import('/src/tab-manager.ts')");
      const manager = new tabModule.TabManager('tab-bar', 'terminal-area');
      manager.createTab('Server-Alpha', { host: '192.168.1.10', port: 22 });
      manager.renderTabBar();
      (window as any).__testTabManager = manager;
    });

    const label = page.locator('#tab-bar .tab-label').first();
    await label.dblclick();

    const input = page.locator('#tab-bar .tab-rename-input');
    await expect(input).toBeVisible();

    // 提交纯空格
    await input.fill('   ');
    await input.press('Enter');

    // 输入框消失，恢复原标签名
    await expect(input).toHaveCount(0);
    await expect(label).toBeVisible();
    await expect(label).toHaveText('Server-Alpha');

    // 再次双击，失焦提交空值同样能恢复
    await label.dblclick();
    const input2 = page.locator('#tab-bar .tab-rename-input');
    await expect(input2).toBeVisible();
    await input2.fill('');
    await page.locator('#terminal-area').click();

    await expect(input2).toHaveCount(0);
    await expect(label).toBeVisible();
    await expect(label).toHaveText('Server-Alpha');
  });

  test('右键菜单外部点击与连续右键不残留或误关', async ({ page }) => {
    await mockAnonymousSession(page);
    await page.goto('/?lang=zh-CN');

    await page.evaluate(async () => {
      document.getElementById('terminal-section')?.classList.remove('hidden');
      document.getElementById('terminal-section')?.classList.add('flex');
      const tabModule = await (window as any).eval("import('/src/tab-manager.ts')");
      const manager = new tabModule.TabManager('tab-bar', 'terminal-area');
      manager.createTab('Server-1', { host: '10.0.0.1', port: 22 });
      manager.createTab('Server-2', { host: '10.0.0.2', port: 22 });
      manager.renderTabBar();
      (window as any).__testTabManager = manager;
    });

    const tabItem = page.locator('#tab-bar .tab-item').first();
    await tabItem.click({ button: 'right' });

    const menu = page.locator('#tab-context-menu');
    await expect(menu).toBeVisible();

    // 点击外部关闭菜单
    await page.locator('#terminal-area').click();
    await expect(menu).toHaveCount(0);

    // 再次右键打开菜单，并通过菜单项触发重命名
    await tabItem.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.getByText('重命名标签页').click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#tab-bar .tab-rename-input')).toBeVisible();
  });
});
