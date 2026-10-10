import { expect, type Page, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function mountTerminal(page: Page, output: string, ready = true): Promise<void> {
  await mockAnonymousSession(page);
  await page.goto('/');
  await expect(page.locator('#connection-form')).toBeVisible();
  await page.evaluate(async ({ output, ready }) => {
    const { SSHTerminal } = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'touch-scroll-terminal';
    root.style.cssText = 'position:fixed;left:0;top:0;width:390px;height:320px;z-index:100;';
    document.body.appendChild(root);
    const terminal = new SSHTerminal(root.id);
    terminal.mount();
    const inputs: string[] = [];
    // Exercise the real xterm -> trzsz -> WebSocket path, including legacy binary mouse reports.
    const socket: any = {
      readyState: WebSocket.OPEN,
      send(data: string | Uint8Array) {
        if (typeof data === 'string' && data.startsWith('{')) {
          const message = JSON.parse(data);
          if (message.type === 'ping') {
            queueMicrotask(() => {
              socket.onmessage(new MessageEvent('message', {
                data: JSON.stringify({ type: 'pong', id: message.id }),
              }));
            });
          }
          return;
        }
        inputs.push(typeof data === 'string' ? data : String.fromCharCode(...data));
      },
      close() { this.readyState = WebSocket.CLOSED; },
    };
    terminal.connectWithWebSocket(socket, undefined, { resetDisplay: false });
    if (ready) {
      socket.onmessage(new MessageEvent('message', {
        data: JSON.stringify({ type: 'status', event: 'shell_ready' }),
      }));
    }
    const xterm = terminal.terminal;
    await new Promise<void>((resolve) => xterm.write(output, resolve));
    const screen = root.querySelector<HTMLElement>('.xterm-screen')!;
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / xterm.cols;
    const cellHeight = rect.height / xterm.rows;
    const startX = rect.left + 9.5 * cellWidth;
    const startY = rect.top + 7.5 * cellHeight;
    const pointer = (type: string, x = 0, y = 0, pointerType = 'touch') => {
      const target = type === 'pointerup' || type === 'pointercancel' ? window : screen;
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 158,
        pointerType,
        clientX: startX + x * cellWidth,
        clientY: startY + y * cellHeight,
      }));
    };
    const swipe = (lines: number) => {
      pointer('pointerdown');
      pointer('pointermove', 0, lines);
      pointer('pointerup', 0, lines);
    };
    (window as any).__touchScroll = { terminal, xterm, socket, inputs, pointer, swipe };
  }, { output, ready });
}

const alternate = '\x1b[?1049h';

for (const protocol of [
  { name: 'VT200 + SGR', tracking: 1000, encoding: '\x1b[?1006h', mode: 'vt200' },
  { name: 'drag + SGR (tmux)', tracking: 1002, encoding: '\x1b[?1006h', mode: 'drag' },
  { name: 'any + SGR', tracking: 1003, encoding: '\x1b[?1006h', mode: 'any' },
  { name: 'VT200 + legacy', tracking: 1000, encoding: '', mode: 'vt200' },
  { name: 'VT200 + SGR pixels', tracking: 1000, encoding: '\x1b[?1016h', mode: 'vt200' },
]) {
  test(`触摸滑动通过 xterm 编码双向远端滚轮：${protocol.name}`, async ({ page }) => {
    await mountTerminal(page, `${alternate}\x1b[?${protocol.tracking}h${protocol.encoding}`);
    const result = await page.evaluate(() => {
      const { terminal, xterm, inputs, swipe } = (window as any).__touchScroll;
      terminal.setMobileModifier('ctrl');
      swipe(4.25);
      const up = inputs.splice(0);
      swipe(-4.25);
      return {
        mode: xterm.modes.mouseTrackingMode,
        up,
        down: [...inputs],
        modifier: terminal.getMobileModifier(),
        viewportY: xterm.buffer.active.viewportY,
        hasSelection: xterm.hasSelection(),
      };
    });
    expect(result.mode).toBe(protocol.mode);
    expect(result.up).toHaveLength(4);
    expect(result.down).toHaveLength(4);
    if (!protocol.encoding) {
      expect(result.up).toEqual(Array(4).fill('\x1b[M`*('));
      expect(result.down).toEqual(Array(4).fill('\x1b[Ma*('));
    } else {
      const up = protocol.encoding.includes('1016') ? /^\[<64;\d+;\d+M$/ : /^\[<64;10;8M$/;
      const down = protocol.encoding.includes('1016') ? /^\[<65;\d+;\d+M$/ : /^\[<65;10;8M$/;
      for (const input of result.up) {
        expect(input.startsWith('\x1b')).toBe(true);
        expect(input.slice(1)).toMatch(up);
      }
      for (const input of result.down) {
        expect(input.startsWith('\x1b')).toBe(true);
        expect(input.slice(1)).toMatch(down);
      }
      // Keep reports anchored to the pane where the gesture began.
      expect(new Set(result.up).size).toBe(1);
      expect(new Set(result.down).size).toBe(1);
    }
    expect(result.modifier).toBe('ctrl');
    expect(result.viewportY).toBe(0);
    expect(result.hasSelection).toBe(false);
  });
}

test('普通终端保留本地历史滑动，备用屏幕和 X10 不产生按键兜底', async ({ page }) => {
  await mountTerminal(page, Array.from({ length: 120 }, (_, i) => `line ${i}\r\n`).join(''));
  const result = await page.evaluate(async () => {
    const { xterm, inputs, swipe } = (window as any).__touchScroll;
    xterm.scrollToBottom();
    const before = xterm.buffer.active.viewportY;
    swipe(4.25);
    const after = xterm.buffer.active.viewportY;
    await new Promise<void>((resolve) => xterm.write('\x1b[?1049h', resolve));
    swipe(4.25);
    await new Promise<void>((resolve) => xterm.write('\x1b[?9h', resolve));
    swipe(-4.25);
    return { before, after, inputs: [...inputs] };
  });
  expect(result.after).toBeLessThan(result.before);
  expect(result.inputs).toEqual([]);
});

test('远端触摸滚轮遵守 Shell 就绪和 WebSocket 开启门控', async ({ page }) => {
  await mountTerminal(page, `${alternate}\x1b[?1002h\x1b[?1006h`, false);
  const result = await page.evaluate(() => {
    const { socket, inputs, swipe } = (window as any).__touchScroll;
    swipe(4.25);
    const beforeReady = [...inputs];
    socket.onmessage(new MessageEvent('message', {
      data: JSON.stringify({ type: 'status', event: 'shell_ready' }),
    }));
    socket.readyState = WebSocket.CLOSED;
    swipe(4.25);
    return { beforeReady, closed: [...inputs] };
  });
  expect(result.beforeReady).toEqual([]);
  expect(result.closed).toEqual([]);
});

test('短点按、水平拖动和桌面指针不触发远端触摸滚轮', async ({ page }) => {
  await mountTerminal(page, `${alternate}\x1b[?1002h\x1b[?1006h`);
  const inputs = await page.evaluate(() => {
    const { inputs, pointer } = (window as any).__touchScroll;
    pointer('pointerdown');
    pointer('pointermove', 0, 0.25);
    pointer('pointerup', 0, 0.25);
    pointer('pointerdown');
    pointer('pointermove', 10, 1);
    pointer('pointermove', 10, 5);
    pointer('pointerup', 10, 5);
    pointer('pointerdown', 0, 0, 'mouse');
    pointer('pointermove', 0, 4.25, 'mouse');
    pointer('pointerup', 0, 4.25, 'mouse');
    return [...inputs];
  });
  expect(inputs).toEqual([]);
});

test('远端鼠标模式下移动选区仍优先，取消手势后不再发送滚轮', async ({ page }) => {
  await mountTerminal(page, `${alternate}\x1b[?1002h\x1b[?1006hhello tmux`);
  const result = await page.evaluate(() => {
    const { terminal, xterm, inputs, pointer, swipe } = (window as any).__touchScroll;
    terminal.setMobileSelectionMode(true);
    swipe(4.25);
    const selected = xterm.hasSelection();
    const selectionInputs = inputs.splice(0);
    terminal.setMobileSelectionMode(false);
    pointer('pointerdown');
    pointer('pointermove', 0, 4.25);
    pointer('pointercancel', 0, 4.25);
    const countAfterCancel = inputs.length;
    pointer('pointermove', 0, 8.25);
    pointer('pointerup', 0, 8.25);
    return { selected, selectionInputs, countAfterCancel, count: inputs.length };
  });
  expect(result.selected).toBe(true);
  expect(result.selectionInputs).toEqual([]);
  expect(result.countAfterCancel).toBe(4);
  expect(result.count).toBe(result.countAfterCancel);
});

test('协议变化与连接重置终止在途手势，极大位移仍有界', async ({ page }) => {
  await mountTerminal(page, `${alternate}\x1b[?1002h\x1b[?1006h`);
  const result = await page.evaluate(async () => {
    const { terminal, xterm, inputs, pointer, swipe } = (window as any).__touchScroll;
    pointer('pointerdown');
    await new Promise<void>((resolve) => xterm.write('\x1b[?1002l\x1b[?1049l', resolve));
    pointer('pointermove', 0, 4.25);
    pointer('pointerup', 0, 4.25);
    const afterModeChange = inputs.length;
    await new Promise<void>((resolve) => xterm.write('\x1b[?1049h\x1b[?1002h', resolve));
    swipe(10000);
    const largeSwipe = inputs.splice(0);
    pointer('pointerdown');
    terminal.disconnect();
    return { afterModeChange, largeSwipe, pendingGesture: terminal.mobileScrollGesture };
  });
  expect(result.afterModeChange).toBe(0);
  expect(result.largeSwipe).toHaveLength(16);
  expect(result.largeSwipe).toEqual(Array(16).fill('\x1b[<64;10;8M'));
  expect(result.pendingGesture).toBeNull();
});
