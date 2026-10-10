import { expect, type Page, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

interface FixtureOptions {
  focusReporting?: boolean;
  initiallyFocused?: boolean;
  ready?: boolean;
  iosLike?: boolean;
}

async function mountTerminal(page: Page, options: FixtureOptions = {}): Promise<void> {
  await mockAnonymousSession(page);
  await page.goto('/');
  await expect(page.locator('#connection-form')).toBeVisible();
  await page.evaluate(async ({ focusReporting = true, initiallyFocused = false, ready = true, iosLike = false }) => {
    if (iosLike) {
      Object.defineProperties(navigator, {
        userAgent: { configurable: true, value: 'Mozilla/5.0 (iPhone)' },
        platform: { configurable: true, value: 'iPhone' },
        maxTouchPoints: { configurable: true, value: 5 },
      });
    }
    const { SSHTerminal } = await (window as any).eval("import('/src/terminal.ts')");
    const { MobileTerminalController } = await (window as any).eval("import('/src/mobile-terminal.ts')");
    document.getElementById('auth-section')!.classList.add('hidden');
    const section = document.getElementById('terminal-section')!;
    section.classList.remove('hidden');
    section.classList.add('flex');
    document.body.classList.add('terminal-active');
    const root = document.createElement('div');
    root.id = 'focus-report-terminal';
    root.style.cssText = 'position:fixed;left:0;top:80px;width:390px;height:320px;';
    document.getElementById('terminal-area')!.appendChild(root);
    const terminal = new SSHTerminal(root.id);
    terminal.mount();
    const inputs: string[] = [];
    const socket: any = {
      readyState: WebSocket.OPEN,
      send(data: string | Uint8Array) {
        if (typeof data === 'string' && data.startsWith('{')) {
          const message = JSON.parse(data);
          if (message.type === 'ping') {
            queueMicrotask(() => socket.onmessage(new MessageEvent('message', {
              data: JSON.stringify({ type: 'pong', id: message.id }),
            })));
          }
          return;
        }
        inputs.push(typeof data === 'string' ? data : String.fromCharCode(...data));
      },
      close() { this.readyState = WebSocket.CLOSED; },
    };
    // Keep xterm focus events, the actual toolbar listeners and trzsz input processing intact.
    terminal.connectWithWebSocket(socket, undefined, { resetDisplay: false });
    if (ready) {
      socket.onmessage(new MessageEvent('message', {
        data: JSON.stringify({ type: 'status', event: 'shell_ready' }),
      }));
    }
    const controller = new MobileTerminalController(() => terminal);
    controller.start();
    if (initiallyFocused) terminal.focus();
    else terminal.blur();
    const xterm = terminal.terminal;
    await new Promise<void>((resolve) => xterm.write(focusReporting ? '\x1b[?1004h' : '\x1b[?1004l', resolve));
    inputs.length = 0;
    (window as any).__focusReport = { terminal, xterm, socket, inputs, controller };
  }, options);
}

for (const focusReporting of [false, true]) {
  for (const initiallyFocused of [false, true]) {
    for (const { modifier, key, expected } of [
      { modifier: 'ctrl', key: 'c', expected: '\x03' },
      { modifier: 'alt', key: 'x', expected: '\x1bx' },
    ]) {
      test(`${modifier} 点击与真实按键：焦点报告=${focusReporting}，初始聚焦=${initiallyFocused}`, async ({ page }) => {
        await mountTerminal(page, { focusReporting, initiallyFocused });
        const button = page.locator(`[data-mobile-modifier="${modifier}"]`);
        await button.tap();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        const afterTap = await page.evaluate(() => {
          const { terminal, inputs } = (window as any).__focusReport;
          return { modifier: terminal.getMobileModifier(), inputs: [...inputs] };
        });
        expect(afterTap.modifier).toBe(modifier);
        if (focusReporting) {
          expect(afterTap.inputs).toContain('\x1b[I');
          for (const report of afterTap.inputs) expect(['\x1b[I', '\x1b[O']).toContain(report);
        } else {
          expect(afterTap.inputs).toEqual([]);
        }
        await page.keyboard.press(key);
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        const result = await page.evaluate(() => {
          const { terminal, inputs } = (window as any).__focusReport;
          return { modifier: terminal.getMobileModifier(), inputs: [...inputs] };
        });
        expect(result.modifier).toBeNull();
        expect(result.inputs).toEqual([...afterTap.inputs, expected]);
      });
    }
  }
}

test('开启焦点报告后 Ctrl 可以重复切换，Ctrl+B 和方向键仍正常', async ({ page }) => {
  await mountTerminal(page);
  const button = page.locator('[data-mobile-modifier="ctrl"]');
  await button.tap();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await button.tap();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.tap();
  await page.keyboard.press('b');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.tap();
  await page.locator('[data-terminal-key="arrow_up"]').tap();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  const inputs = await page.evaluate(() => (window as any).__focusReport.inputs
    .filter((data: string) => data !== '\x1b[I' && data !== '\x1b[O'));
  expect(inputs).toEqual(['\x02', '\x1b[1;5A']);
});

test('焦点报告不改变 bracketed paste 和粘贴清除修饰键的既有语义', async ({ page }) => {
  await mountTerminal(page);
  const result = await page.evaluate(async () => {
    const { terminal, xterm, inputs } = (window as any).__focusReport;
    await new Promise<void>((resolve) => xterm.write('\x1b[?2004h', resolve));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'first\nsecond' },
    });
    terminal.setMobileModifier('alt');
    await terminal.pasteFromClipboard();
    return { modifier: terminal.getMobileModifier(), inputs: [...inputs] };
  });
  expect(result.modifier).toBeNull();
  expect(result.inputs).toEqual(['\x1b[200~first\rsecond\x1b[201~']);
});

test('焦点报告保持 Shell 就绪和连接状态门控', async ({ page }) => {
  await mountTerminal(page, { ready: false });
  await page.locator('[data-mobile-modifier="alt"]').tap();
  const result = await page.evaluate(() => {
    const { terminal, socket, inputs } = (window as any).__focusReport;
    const beforeReady = [...inputs];
    socket.onmessage(new MessageEvent('message', {
      data: JSON.stringify({ type: 'status', event: 'shell_ready' }),
    }));
    terminal.blur();
    terminal.focus();
    const readyReports = inputs.splice(0);
    socket.readyState = WebSocket.CLOSED;
    terminal.blur();
    terminal.focus();
    return { beforeReady, readyReports, closedReports: [...inputs], modifier: terminal.getMobileModifier() };
  });
  expect(result.beforeReady).toEqual([]);
  expect(result.readyReports).toEqual(['\x1b[O', '\x1b[I']);
  expect(result.closedReports).toEqual([]);
  expect(result.modifier).toBe('alt');
});

for (const xtermHandled of [false, true]) {
  test(`焦点报告不干扰 iOS IME 延迟回退或去重：xterm已处理=${xtermHandled}`, async ({ page }) => {
    await mountTerminal(page, { focusReporting: false, initiallyFocused: true, iosLike: true });
    const result = await page.evaluate(async (xtermHandled) => {
      const { terminal, xterm, inputs } = (window as any).__focusReport;
      const textarea = document.querySelector<HTMLTextAreaElement>('#focus-report-terminal .xterm-helper-textarea')!;
      const dispatchKey = (type: 'keydown' | 'keyup', keyCode: number) => {
        const event = new KeyboardEvent(type, { bubbles: true, key: '。' });
        Object.defineProperty(event, 'keyCode', { value: keyCode });
        textarea.dispatchEvent(event);
      };
      const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
      textarea.value = '';
      dispatchKey('keydown', 229);
      if (xtermHandled) textarea.value = '。';
      await delay();
      // DECSET 1004 immediately reports current focus via real xterm onData without losing textarea contents.
      await new Promise<void>((resolve) => xterm.write('\x1b[?1004h', resolve));
      const handledAfterFocus = terminal.imePendingHandled;
      if (!xtermHandled) textarea.value = '。';
      dispatchKey('keyup', 0);
      await delay();
      return { handledAfterFocus, inputs: [...inputs] };
    }, xtermHandled);
    expect(result.handledAfterFocus).toBe(xtermHandled);
    expect(result.inputs).toContain('\x1b[I');
    expect(result.inputs.filter((data: string) => data !== '\x1b[I' && data !== '\x1b[O')).toEqual(['。']);
  });
}
