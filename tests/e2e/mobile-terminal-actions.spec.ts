import { expect, test, type Page } from './fixtures';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function mount(page: Page) {
  await mockAnonymousSession(page);
  await page.goto('/?lang=en-US');
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(async () => {
    const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
    document.getElementById('auth-section')!.classList.add('hidden');
    document.getElementById('terminal-section')!.classList.remove('hidden');
    document.getElementById('terminal-section')!.classList.add('flex');
    document.body.classList.add('terminal-active');
    const tm = getTabManager();
    const first = tm.createTab('First'); const second = tm.createTab('Second');
    tm.switchTab(first.id);
    const terminal = first.terminal;
    const sent: string[] = [];
    const socket = { readyState: WebSocket.OPEN as number, send: (data: string) => sent.push(data), close() { this.readyState = WebSocket.CLOSED; } };
    terminal.ws = socket;
    terminal.setupWebSocketHandlers();
    terminal.sessionReady = true;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { throw new Error('denied'); } } });
    (window as any).__actions = { tm, first, second, terminal, sent, socket };
  });
}

async function pasteFallback(page: Page) {
  await page.evaluate(() => { void (window as any).__actions.terminal.pasteFromClipboard(); });
  await expect(page.locator('.terminal-paste-dialog')).toBeVisible();
}

test('manual paste is explicit, multiline, bounded, and uses xterm bracketed paste and trzsz', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const { terminal } = (window as any).__actions;
    await new Promise<void>(resolve => terminal.terminal.write('\x1b[?2004h', resolve));
  });
  await pasteFallback(page);
  const input = page.locator('.terminal-paste-dialog textarea');
  await input.fill('one\ntwo\n');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as any).__actions.sent)).toEqual([]);
  await input.fill('x'.repeat(65537));
  await expect(page.locator('.terminal-paste-dialog button[type=submit]')).toBeDisabled();
  await expect(page.locator('.terminal-paste-dialog [role=alert]')).toContainText('65,536');
  await input.fill('one\ntwo\n');
  await page.locator('.terminal-paste-dialog button[type=submit]').tap();
  await expect(page.locator('.terminal-paste-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__actions.sent)).toEqual(['\x1b[200~one\rtwo\r\x1b[201~']);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /paste/i.test(key)))).toEqual([]);
});

test('repeated paste does not stack dialogs; tab switch and socket replacement invalidate drafts and delayed reads', async ({ page }) => {
  await mount(page);
  await pasteFallback(page);
  await page.locator('.terminal-paste-dialog textarea').fill('secret draft');
  await page.evaluate(() => { void (window as any).__actions.terminal.pasteFromClipboard(); });
  await expect(page.locator('.terminal-paste-dialog')).toHaveCount(1);
  await page.evaluate(() => {
    const { tm, second } = (window as any).__actions; tm.switchTab(second.id);
  });
  await expect(page.locator('.terminal-paste-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__actions.sent)).toEqual([]);
  await page.evaluate(() => {
    const state = (window as any).__actions;
    state.tm.switchTab(state.first.id);
    navigator.clipboard.readText = () => new Promise<string>(resolve => { state.resolveRead = resolve; });
    state.pendingPaste = state.terminal.pasteFromClipboard();
    state.terminal.ws = { ...state.socket };
    state.resolveRead('late secret');
  });
  expect(await page.evaluate(() => (window as any).__actions.pendingPaste)).toBe(false);
  expect(await page.evaluate(() => (window as any).__actions.sent)).toEqual([]);
});

test('manual paste respects Shell readiness, cancellation and disconnection', async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(async () => {
    const { terminal } = (window as any).__actions;
    terminal.sessionReady = false;
    return terminal.pasteFromClipboard();
  })).toBe(false);
  await expect(page.locator('.terminal-paste-dialog')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__actions.terminal.sessionReady = true; });
  await pasteFallback(page);
  await page.locator('.terminal-paste-dialog .app-dialog__button--cancel').tap();
  await pasteFallback(page);
  await page.locator('.terminal-paste-dialog textarea').fill('do not send');
  await page.evaluate(() => (window as any).__actions.socket.onclose({ code: 1000 }));
  await expect(page.locator('.terminal-paste-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__actions.sent)).toEqual([]);
});

test('saved-server duplication from the mobile menu obtains a fresh independent connection', async ({ page }) => {
  await mount(page);
  const connections: string[] = [];
  await page.route('**/api/servers/7/connect', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const url = new URL(page.url());
    const wsUrl = `ws://${url.host}/mobile-clone-${connections.length + 1}`;
    connections.push(wsUrl);
    await route.fulfill({ json: { wsUrl } });
  });
  await page.routeWebSocket('**/mobile-clone-*', socket => {
    socket.onMessage(() => {});
  });
  await page.evaluate(() => {
    const state = (window as any).__actions;
    state.tm.setUser(42);
    state.first = state.tm.createTab('Saved', { serverId: 7, host: 'example.com', port: 22 });
    document.getElementById('auth-section')!.classList.add('hidden');
    document.getElementById('terminal-section')!.classList.remove('hidden');
    document.getElementById('terminal-section')!.classList.add('flex');
    document.body.classList.add('terminal-active');
  });
  for (let index = 0; index < 2; index++) {
    await page.locator('#mobile-more-btn').tap();
    await page.locator('#mobile-tab-actions-btn').tap();
    await page.locator('#tab-context-menu').getByRole('button', { name: 'Duplicate session' }).tap();
    await expect.poll(() => page.evaluate(() => (window as any).__actions.tm.getTabCount())).toBe(index + 2);
  }
  expect(connections).toHaveLength(2);
  expect(new Set(connections).size).toBe(2);
});

test('mobile menu provides reachable tab actions and reuses rename and close-other behavior', async ({ page }) => {
  await mount(page);
  await page.locator('#mobile-more-btn').tap();
  await page.locator('#mobile-tab-actions-btn').tap();
  const menu = page.locator('#tab-context-menu');
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await menu.getByRole('button', { name: 'Rename' }).tap();
  await page.locator('.tab-rename-input').fill('Renamed');
  await page.locator('.tab-rename-input').press('Enter');
  expect(await page.evaluate(() => (window as any).__actions.tm.getActiveTab().label)).toBe('Renamed');
  await page.locator('#mobile-more-btn').tap();
  await page.locator('#mobile-tab-actions-btn').tap();
  await menu.getByRole('button', { name: 'Close other tabs' }).tap();
  expect(await page.evaluate(() => (window as any).__actions.tm.getTabCount())).toBe(1);
});
