import { expect, test, type Page } from './fixtures';
import { mockAnonymousSession } from './helpers';

async function mountList(page: Page, count = 6) {
  await mockAnonymousSession(page);
  await page.goto('/?lang=en-US');
  await page.evaluate(async (count) => {
    const { SFTPPanel } = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new SFTPPanel(() => null);
    panel.bindEvents();
    panel.visible = true;
    panel.sftpReady = true;
    panel.container.style.transform = 'translateX(0)';
    const entries = Array.from({ length: count }, (_, index) => ({
      name: `file-${String(index).padStart(4, '0')}.txt`, type: 'file',
      size: index + 1, sizeFormatted: `${index + 1} B`, permissions: '-rw-r--r--',
      permissionsRaw: 0o100644, modifiedTime: index, isDir: false, isLink: false,
    }));
    const opened: string[] = [];
    panel.openEntry = async (entry: { name: string }) => { opened.push(entry.name); };
    panel.sendJSON = () => {};
    panel.handleMessage({ type: 'sftp_list_result', path: '/files', entries });
    (window as any).__listPanel = panel;
    (window as any).__listEntries = entries;
    (window as any).__listOpened = opened;
  }, count);
}

async function selectedNames(page: Page) {
  const names = await page.locator('#sftp-entries [aria-selected="true"]').evaluateAll(
    (rows) => rows.map((row) => (row as HTMLElement).dataset.name).sort()
  );
  const highlighted = await page.locator('#sftp-entries .bg-surface-variant').evaluateAll(
    (rows) => rows.map((row) => (row as HTMLElement).dataset.name).sort()
  );
  expect(highlighted).toEqual(names);
  return names;
}

const row = (page: Page, index: number) =>
  page.locator(`#sftp-entries [data-name="file-${String(index).padStart(4, '0')}.txt"]`);

test('nested row targets preserve single, Ctrl/Cmd, Shift and context-menu selection', async ({ page }) => {
  await mountList(page);
  await row(page, 0).locator('span').first().click();
  await row(page, 2).locator('span').nth(1).click({ modifiers: ['Shift'] });
  expect(await selectedNames(page)).toEqual(['file-0000.txt', 'file-0001.txt', 'file-0002.txt']);
  // Native Control-click opens a context menu on macOS; dispatch its logical click explicitly.
  await row(page, 1).dispatchEvent('click', { ctrlKey: true });
  expect(await selectedNames(page)).toEqual(['file-0000.txt', 'file-0002.txt']);
  await row(page, 3).click({ modifiers: ['Meta'] });
  expect(await selectedNames(page)).toEqual(['file-0000.txt', 'file-0002.txt', 'file-0003.txt']);
  await row(page, 0).locator('span').first().click({ button: 'right' });
  expect(await selectedNames(page)).toEqual(['file-0000.txt', 'file-0002.txt', 'file-0003.txt']);
  await page.evaluate(() => (window as any).__listPanel.hideContextMenu());
  await row(page, 5).locator('span').nth(1).click({ button: 'right' });
  expect(await selectedNames(page)).toEqual(['file-0005.txt']);
  await page.locator('#sftp-context-menu > div').first().click();
  expect(await page.evaluate(() => (window as any).__listOpened)).toEqual(['file-0005.txt']);
});

test('sort and refresh keep highlights aligned and open the current row exactly once', async ({ page }) => {
  await mountList(page);
  await row(page, 2).click();
  await page.locator('#sftp-sort-size').click();
  expect(await selectedNames(page)).toEqual(['file-0002.txt']);
  await page.locator('#sftp-entries .sftp-entry').first().locator('span').nth(1).dblclick();
  expect(await page.evaluate(() => (window as any).__listOpened)).toEqual(['file-0005.txt']);
  await page.evaluate(() => {
    const panel = (window as any).__listPanel;
    for (let index = 0; index < 3; index++) {
      panel.handleMessage({ type: 'sftp_list_result', path: '/files', entries: (window as any).__listEntries });
    }
  });
  await page.locator('#sftp-entries .sftp-entry').last().locator('span').first().dblclick();
  expect(await page.evaluate(() => (window as any).__listOpened)).toEqual(['file-0005.txt', 'file-0000.txt']);
  expect(await selectedNames(page)).toEqual(['file-0000.txt']);
});

test('select-all, empty refresh and disposal do not retain stale row state', async ({ page }) => {
  await mountList(page);
  await row(page, 0).click();
  await page.keyboard.press('ControlOrMeta+A');
  expect(await selectedNames(page)).toHaveLength(6);
  await page.keyboard.press('Escape');
  expect(await selectedNames(page)).toEqual([]);
  await page.evaluate(() => {
    const panel = (window as any).__listPanel;
    panel.handleMessage({ type: 'sftp_list_result', path: '/empty', entries: [] });
  });
  await page.keyboard.press('ControlOrMeta+A');
  await expect(page.locator('#sftp-entries .sftp-entry')).toHaveCount(0);
  await expect(page.locator('#sftp-download-btn')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__listPanel.selectedEntries.size)).toBe(0);
  await page.evaluate(() => {
    const oldPanel = (window as any).__listPanel;
    const entries = (window as any).__listEntries;
    oldPanel.handleMessage({ type: 'sftp_list_result', path: '/files', entries });
    oldPanel.clearSelection();
    oldPanel.dispose();
    (window as any).__oldListPanel = oldPanel;
    const panel = new oldPanel.constructor(() => null);
    panel.bindEvents();
    panel.visible = true;
    panel.sftpReady = true;
    panel.container.style.transform = 'translateX(0)';
    panel.handleMessage({ type: 'sftp_list_result', path: '/new', entries: entries.slice(0, 2) });
    (window as any).__listPanel = panel;
  });
  await page.keyboard.press('ControlOrMeta+A');
  expect(await selectedNames(page)).toHaveLength(2);
  expect(await page.evaluate(() => {
    const oldPanel = (window as any).__oldListPanel;
    return [oldPanel.selectedEntries.size, oldPanel.entryRows.size, oldPanel.highlightedNames.size];
  })).toEqual([0, 0, 0]);
});

test('large-list work measurement (timings are evidence, not CI thresholds)', async ({ page }, testInfo) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=en-US');
  const metrics = await page.evaluate(async () => {
    const { SFTPPanel } = await (window as any).eval("import('/src/sftp-panel.ts')");
    let rowRegistrations = 0;
    let hostRegistrations = 0;
    let ariaWrites = 0;
    const originalAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof Element && ['click', 'dblclick', 'contextmenu'].includes(type)) {
        if (this.classList.contains('sftp-entry')) rowRegistrations++;
        if (this.id === 'sftp-entries') hostRegistrations++;
      }
      return originalAdd.call(this, type, listener, options);
    };
    const panel = new SFTPPanel(() => null);
    panel.bindEvents();
    const entries = Array.from({ length: 2000 }, (_, index) => ({
      name: `file-${String(index).padStart(4, '0')}.txt`, type: 'file',
      size: index, sizeFormatted: `${index} B`, permissions: '-rw-r--r--',
      permissionsRaw: 0o100644, modifiedTime: index, isDir: false, isLink: false,
    }));
    const refresh = () => panel.handleMessage({ type: 'sftp_list_result', path: '/large', entries });
    refresh();
    const registrationsPerRender = rowRegistrations;
    refresh();
    const registrationsOnRefresh = rowRegistrations - registrationsPerRender;
    EventTarget.prototype.addEventListener = originalAdd;
    const list = document.querySelector('#sftp-entries')!;
    const originalSet = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (name === 'aria-selected' && this.classList.contains('sftp-entry')) ariaWrites++;
      return originalSet.call(this, name, value);
    };
    const click = (index: number) => list.children[index].firstElementChild!.dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    click(0);
    const writesFirstClick = ariaWrites;
    ariaWrites = 0;
    click(1);
    const writesNextClick = ariaWrites;
    ariaWrites = 0;
    click(1);
    const writesUnchangedClick = ariaWrites;
    Element.prototype.setAttribute = originalSet;
    // Do not include instrumentation overhead in timing samples.
    panel.clearSelection();
    await document.fonts.ready;
    const renderMs: number[] = [];
    for (let index = 0; index < 12; index++) {
      const start = performance.now();
      refresh();
      if (index >= 2) renderMs.push(performance.now() - start);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const start = performance.now();
    for (let index = 0; index < 100; index++) click(index % 2);
    const clickMs = (performance.now() - start) / 100;
    const result = {
      rows: list.children.length, registrationsPerRender, registrationsOnRefresh, hostRegistrations,
      writesFirstClick, writesNextClick, writesUnchangedClick,
      renderMedianMs: renderMs.sort((a, b) => a - b)[Math.floor(renderMs.length / 2)], clickMeanMs: clickMs,
    };
    panel.dispose();
    return result;
  });
  await testInfo.attach('sftp-list-work', {
    body: Buffer.from(JSON.stringify(metrics, null, 2)), contentType: 'application/json',
  });
  expect(metrics.rows).toBe(2000);
  expect(metrics.registrationsPerRender).toBe(0);
  expect(metrics.registrationsOnRefresh).toBe(0);
  expect(metrics.hostRegistrations).toBe(3);
  expect(metrics.writesFirstClick).toBe(1);
  expect(metrics.writesNextClick).toBe(2);
  expect(metrics.writesUnchangedClick).toBe(0);
});
