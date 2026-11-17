import { expect, test, type Page } from './fixtures';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function mount(page: Page, withTabs = false) {
  await mockAnonymousSession(page);
  await page.goto('/?lang=en-US');
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(async (withTabs) => {
    const { SFTPPanel } = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new SFTPPanel(() => null);
    panel.bindEvents(); panel.visible = true; panel.sftpReady = true;
    panel.container.style.transform = 'translateX(0)';
    const messages: any[] = [];
    panel.sendJSON = (data: any) => messages.push(data);
    panel.handleMessage({ type: 'sftp_list_result', path: '/files', entries: Array.from({ length: 5 }, (_, i) => ({
      name: `file-${i}.txt`, type: i === 0 ? 'dir' : 'file', isDir: i === 0, isLink: false,
      size: 1, sizeFormatted: '1 B', permissions: '-rw-r--r--', permissionsRaw: 0o100644, modifiedTime: 1,
    })) });
    const state: any = { panel, messages };
    if (withTabs) {
      const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
      const tm = getTabManager();
      const first = tm.createTab('First'); const second = tm.createTab('Second');
      tm.switchTab(first.id); first.sftpPanel = panel;
      document.getElementById('auth-section')!.classList.add('hidden');
      document.getElementById('terminal-section')!.classList.remove('hidden');
      document.getElementById('terminal-section')!.classList.add('flex');
      document.body.classList.add('terminal-active');
      Object.assign(state, { tm, first, second });
    }
    (window as any).__sftpTouch = state;
  }, withTabs);
}

const selected = (page: Page) => page.locator('#sftp-entries [aria-selected="true"]').count();

test('pure touch can select disjoint files, toggle checkboxes, select all and explicitly open a directory', async ({ page }) => {
  await mount(page);
  await page.locator('#sftp-multi-btn').tap();
  await page.locator('.sftp-entry').nth(1).tap();
  await page.locator('.sftp-entry').nth(3).tap();
  expect(await selected(page)).toBe(2);
  await expect(page.locator('#sftp-open-btn')).toBeDisabled();
  await page.locator('.sftp-entry').nth(1).locator('input').tap();
  expect(await selected(page)).toBe(1);
  await page.locator('#sftp-select-all-btn').tap();
  expect(await selected(page)).toBe(5);
  await page.locator('#sftp-clear-selection-btn').tap();
  expect(await selected(page)).toBe(0);
  await page.locator('#sftp-multi-btn').tap();
  await page.locator('.sftp-entry').first().tap();
  await page.locator('#sftp-open-btn').tap();
  expect(await page.evaluate(() => (window as any).__sftpTouch.messages)).toContainEqual({ type: 'sftp_list', path: '/files/file-0.txt' });
  await expect(page.locator('#sftp-multi-btn')).toHaveAttribute('aria-pressed', 'false');
});

test('multi-select never opens on double click and selected deletion reuses batch operations', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const panel = (window as any).__sftpTouch.panel;
    panel.openEntry = () => { throw new Error('must not open in multi-select'); };
  });
  await page.locator('#sftp-multi-btn').tap();
  await page.locator('.sftp-entry').nth(1).dispatchEvent('dblclick');
  await page.locator('.sftp-entry').nth(1).tap();
  await page.locator('.sftp-entry').nth(3).tap();
  // The normal delete button may need horizontal scrolling; Playwright scrolls it into view.
  await page.locator('#sftp-delete-btn').tap();
  await page.locator('.app-dialog__button--confirm').tap();
  await expect.poll(() => page.evaluate(() => (window as any).__sftpTouch.messages.filter((m: any) => m.type === 'sftp_delete').length)).toBe(2);
});

test('active transfer close asks once, cancel preserves the panel and approval uses normal cleanup', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { (window as any).__sftpTouch.panel.downloadActive = true; });
  await page.locator('#sftp-close-btn').tap();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => (window as any).__sftpTouch.panel.requestHide());
  await page.locator('.app-dialog__button--cancel').tap();
  expect(await page.evaluate(() => (window as any).__sftpTouch.panel.isVisible())).toBe(true);
  expect(await page.evaluate(() => (window as any).__sftpTouch.messages)).toEqual([]);
  await page.locator('#sftp-close-btn').tap();
  await page.locator('.app-dialog__button--confirm').tap();
  await expect.poll(() => page.evaluate(() => (window as any).__sftpTouch.panel.isVisible())).toBe(false);
  expect(await page.evaluate(() => (window as any).__sftpTouch.messages)).toContainEqual({ type: 'sftp_close' });
});

test('navigation cancellation stays on the current tab; forced disposal invalidates late approval', async ({ page }) => {
  await mount(page, true);
  await page.evaluate(() => {
    const { panel } = (window as any).__sftpTouch;
    panel.uploadActive = true;
    // The full-screen SFTP overlay hides the tab bar; use the same delegated click event.
    const tabId = (window as any).__sftpTouch.second.id;
    (document.querySelector(`[data-tab-id="${tabId}"]`) as HTMLElement).click();
  });
  await page.locator('.app-dialog__button--cancel').tap();
  expect(await page.evaluate(() => (window as any).__sftpTouch.tm.getActiveTab().label)).toBe('First');
  await page.evaluate(() => {
    const { tm, panel } = (window as any).__sftpTouch;
    tm.runAfterTransferConfirmation(() => { throw new Error('late approval must not navigate'); });
    panel.dispose();
  });
  await page.locator('.app-dialog__button--confirm').tap();
  expect(await page.evaluate(() => (window as any).__sftpTouch.tm.getActiveTab().label)).toBe('First');
});

test('connection-page navigation and drawer switching preserve transfers when cancelled', async ({ page }) => {
  await mount(page, true);
  await page.evaluate(async () => {
    const { panel } = (window as any).__sftpTouch;
    panel.downloadActive = true;
    const { showConnectionPage } = await (window as any).eval("import('/src/main.ts')");
    showConnectionPage();
  });
  await page.locator('.app-dialog__button--cancel').tap();
  await expect(page.locator('#terminal-section')).toBeVisible();
  await page.evaluate(() => document.getElementById('mobile-snippets-btn')!.click());
  await page.locator('.app-dialog__button--cancel').tap();
  expect(await page.evaluate(() => (window as any).__sftpTouch.panel.isVisible())).toBe(true);
});
