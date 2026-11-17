import { expect, test, type Page } from './fixtures';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function mount(page: Page, text = 'FIRST 中文🙂 e\u0301 last', controller = true) {
  await mockAnonymousSession(page);
  await page.goto('/?lang=en-US');
  await page.evaluate(async ({ text, controller }) => {
    const { SSHTerminal } = await (window as any).eval("import('/src/terminal.ts')");
    const { MobileTerminalController } = await (window as any).eval("import('/src/mobile-terminal.ts')");
    const root = document.createElement('div');
    root.id = 'selection-test';
    root.style.cssText = 'position:fixed;left:0;top:80px;width:100vw;height:320px;z-index:20';
    document.body.append(root);
    const terminal = new SSHTerminal(root.id);
    terminal.mount();
    if (controller) new MobileTerminalController(() => terminal).start();
    const xterm = terminal.terminal;
    await new Promise<void>(resolve => xterm.write(text, resolve));
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => copied.push(text) } });
    const pointer = (type: string, column: number, row: number, target?: Element, xOffset = 0, yOffset = 0) => {
      const screen = root.querySelector('.xterm-screen')!;
      const rect = screen.getBoundingClientRect();
      (target ?? (type === 'pointerup' || type === 'pointercancel' ? window : screen)).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 81, pointerType: 'touch', button: 0,
        clientX: rect.left + (column + 0.5) * rect.width / xterm.cols + xOffset,
        clientY: rect.top + (row + 0.5) * rect.height / xterm.rows + yOffset,
      }));
    };
    (window as any).__selection = { terminal, xterm, root, copied, pointer };
  }, { text, controller });
}

test('select mode copies exact wide glyphs and first column, preserves failed copies, and isolates native menus', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const { terminal, xterm, root, pointer } = (window as any).__selection;
    const menu = () => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      root.querySelector('.xterm-screen').dispatchEvent(event);
      return event.defaultPrevented;
    };
    const normalMenuBlocked = menu();
    terminal.setMobileSelectionMode(true);
    pointer('pointerdown', 0, 0); pointer('pointerup', 0, 0);
    const first = xterm.getSelection();
    const glyphs: string[] = [];
    for (const wanted of ['🙂', 'e\u0301']) {
      const line = xterm.buffer.active.getLine(0);
      for (let column = 0; column < xterm.cols; column++) {
        const cell = line.getCell(column);
        if (cell.getChars() !== wanted) continue;
        pointer('pointerdown', column + cell.getWidth() - 1, 0);
        pointer('pointerup', column + cell.getWidth() - 1, 0);
        glyphs.push(xterm.getSelection());
        break;
      }
    }
    // 中 occupies columns 6/7; touching its continuation cell must include the complete glyph.
    pointer('pointerdown', 7, 0); pointer('pointerup', 7, 0);
    const wide = xterm.getSelection();
    const selectionMenuBlocked = menu();
    return { normalMenuBlocked, selectionMenuBlocked, first, wide, glyphs };
  });
  expect(result).toEqual({ normalMenuBlocked: false, selectionMenuBlocked: true, first: 'F', wide: '中', glyphs: ['🙂', 'e\u0301'] });
  await page.evaluate(async () => {
    const { terminal } = (window as any).__selection;
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    document.getElementById('mobile-selection-copy-btn')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!terminal.isMobileSelectionMode()) throw new Error('failed copy lost selection');
  });
  expect(await page.evaluate(() => (window as any).__selection.xterm.getSelection())).toBe('中');
  await page.evaluate(() => document.getElementById('mobile-selection-cancel-btn')!.click());
  expect(await page.evaluate(() => (window as any).__selection.xterm.hasSelection())).toBe(false);
});

test('endpoint handles retain the opposite endpoint and do not jump when grabbed at a clamped edge', async ({ page }) => {
  await mount(page, '0123456789');
  const result = await page.evaluate(() => {
    const { terminal, xterm, root, pointer } = (window as any).__selection;
    terminal.setMobileSelectionMode(true);
    pointer('pointerdown', 0, 0); pointer('pointermove', 4, 0); pointer('pointerup', 4, 0);
    const before = xterm.getSelection();
    const handle = root.querySelector('[data-endpoint="end"]') as HTMLElement;
    const rect = handle.getBoundingClientRect();
    const screen = root.querySelector('.xterm-screen').getBoundingClientRect();
    const x = rect.left + 22, y = rect.top + 29;
    const fire = (type: string, dx = 0) => (type === 'pointerdown' ? handle : type === 'pointermove' ? root : window)
      .dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 81, pointerType: 'touch', button: 0, clientX: x + dx, clientY: y }));
    fire('pointerdown');
    const grabbed = xterm.getSelection();
    fire('pointermove', screen.width / xterm.cols * 2); fire('pointerup', screen.width / xterm.cols * 2);
    const after = xterm.getSelection();
    const start = root.querySelector('[data-endpoint="start"]') as HTMLElement;
    const boundaryX = start.getBoundingClientRect().left + Number.parseFloat(start.style.getPropertyValue('--selection-anchor-x'));
    return { before, grabbed, after, width: rect.width, left: rect.left, boundaryOffset: boundaryX - screen.left };
  });
  expect(result.before).toBe('01234');
  expect(result.grabbed).toBe(result.before);
  expect(result.after).toBe('0123456');
  expect(result.width).toBe(44);
  expect(result.left).toBeGreaterThanOrEqual(0);
  // Enlarging/clamping the hit target must never shift its visible stem to the third character.
  expect(result.boundaryOffset).toBeCloseTo(0, 1);
});

test('edge drag extends into history locally and stops on cancel', async ({ page }) => {
  await mount(page, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\r\n'));
  await page.evaluate(() => {
    const { terminal, xterm, pointer } = (window as any).__selection;
    xterm.scrollToTop();
    terminal.setMobileSelectionMode(true);
    pointer('pointerdown', 0, 0); pointer('pointermove', 5, xterm.rows + 1);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__selection.xterm.buffer.active.viewportY)).toBeGreaterThan(1);
  const stopped = await page.evaluate(() => {
    const { xterm, pointer } = (window as any).__selection;
    pointer('pointercancel', 0, 0);
    return { y: xterm.buffer.active.viewportY, text: xterm.getSelection() };
  });
  expect(stopped.text).toContain('line 0');
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => (window as any).__selection.xterm.buffer.active.viewportY)).toBe(stopped.y);
});

test('font preference persists, height-only fits keep selection and column reflow clears it', async ({ page }) => {
  await mount(page, 'FIRST 中文🙂 last', false);
  const result = await page.evaluate(() => {
    const { terminal, xterm, root, pointer } = (window as any).__selection;
    terminal.setMobileSelectionMode(true);
    pointer('pointerdown', 0, 0); pointer('pointerup', 2, 0);
    root.style.height = '280px'; terminal.fit();
    const retained = terminal.isMobileSelectionMode() && xterm.getSelection() === 'FIR';
    document.getElementById('mobile-font-larger')!.click();
    return { retained, font: xterm.options.fontSize, mode: terminal.isMobileSelectionMode(), selection: xterm.getSelection() };
  });
  expect(result).toEqual({ retained: true, font: 13, mode: false, selection: '' });
  await page.reload();
  await expect(page.locator('#mobile-font-value')).toHaveText('13px');
  await page.evaluate(() => document.getElementById('mobile-font-auto')!.click());
  await expect(page.locator('#mobile-font-value')).toHaveText('12px');
});
