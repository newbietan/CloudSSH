import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('iOS 输入法按真实 keyup 键码补发空格和标点且不重复发送', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/');

  const sent = await page.evaluate(async () => {
    const descriptors = {
      userAgent: Object.getOwnPropertyDescriptor(navigator, 'userAgent'),
      platform: Object.getOwnPropertyDescriptor(navigator, 'platform'),
      maxTouchPoints: Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints'),
    };
    Object.defineProperties(navigator, {
      userAgent: { configurable: true, value: 'Mozilla/5.0 (iPhone)' },
      platform: { configurable: true, value: 'iPhone' },
      maxTouchPoints: { configurable: true, value: 5 },
    });

    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'ios-ime-test-root';
    root.style.cssText = 'width:390px;height:320px;';
    document.body.appendChild(root);
    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();

    const payloads: string[] = [];
    (terminal as any).ws = { readyState: WebSocket.OPEN, close: () => undefined };
    (terminal as any).trzszFilter = {
      processTerminalInput: (data: string) => payloads.push(data),
    };
    (terminal as any).sessionReady = true;

    const textarea = root.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const dispatchKey = (type: 'keydown' | 'keyup', key: string, keyCode: number): void => {
      const event = new KeyboardEvent(type, { bubbles: true, key });
      Object.defineProperty(event, 'keyCode', { value: keyCode });
      textarea.dispatchEvent(event);
    };
    const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
    const typeAfterXtermFallback = async (
      before: string,
      after: string,
      key: string,
      keyupCode: number,
    ): Promise<void> => {
      textarea.value = before;
      dispatchKey('keydown', key, 229);
      // 真实 Safari 中 xterm.js 的 keydown 定时器可能先运行，此时 textarea
      // 还没有更新；最终字符直到 input/keyup 阶段才可见。
      await delay();
      textarea.value = after;
      dispatchKey('keyup', key, keyupCode);
      await delay();
    };

    await typeAfterXtermFallback('', ' ', ' ', 32);
    await typeAfterXtermFallback(' ', ' .', '.', 190);
    await typeAfterXtermFallback(' .', ' .、', '、', 0);
    await typeAfterXtermFallback(' .、', ' .、 ', ' ', 32);
    // iOS 连续空格可能把末尾空格替换为中文句号。
    await typeAfterXtermFallback(' .、 ', ' .、。', ' ', 32);

    // xterm.js 若已在自身 0ms 回退中产生 onData，本地兼容层不得补发。
    textarea.value = ' .、。';
    dispatchKey('keydown', '！', 229);
    textarea.value = ' .、。！';
    await delay();
    dispatchKey('keyup', '！', 0);
    await delay();

    terminal.dispose();
    root.remove();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(navigator, key, descriptor);
      else delete (navigator as any)[key];
    }
    return payloads;
  });

  expect(sent).toEqual([' ', '.', '、', ' ', '\x7f。', '！']);
});
