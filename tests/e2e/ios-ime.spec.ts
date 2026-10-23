import { expect, type Page, test } from './fixtures';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

// Exercise real xterm onData -> Shell-ready gate -> trzsz -> socket, not sendInput mocks.
async function mountTerminal(page: Page, iosLike = true, ready = true): Promise<void> {
  await mockAnonymousSession(page);
  await page.goto('/');
  await page.evaluate(async ({ iosLike, ready }) => {
    Object.defineProperties(navigator, {
      userAgent: { configurable: true, value: iosLike ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (Macintosh)' },
      platform: { configurable: true, value: iosLike ? 'iPhone' : 'MacIntel' },
      maxTouchPoints: { configurable: true, value: iosLike ? 5 : 0 },
    });
    const { SSHTerminal } = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'ime-test-terminal';
    root.style.cssText = 'position:fixed;top:0;left:0;width:390px;height:320px;';
    document.body.appendChild(root);
    const terminal = new SSHTerminal(root.id);
    terminal.mount();
    const inputs: string[] = [];
    const socket: any = {
      readyState: WebSocket.OPEN,
      send(data: string | Uint8Array) {
        if (typeof data === 'string' && data.startsWith('{')) return;
        inputs.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
      },
      close() { this.readyState = WebSocket.CLOSED; },
    };
    terminal.connectWithWebSocket(socket, undefined, { resetDisplay: false });
    if (ready) {
      socket.onmessage(new MessageEvent('message', {
        data: JSON.stringify({ type: 'status', event: 'shell_ready' }),
      }));
    }
    const textarea = root.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const key = (type: string, key: string, keyCode: number, isComposing = false) => {
      const event = new KeyboardEvent(type, {
        bubbles: true, cancelable: true, key, keyCode, isComposing,
        charCode: type === 'keypress' ? keyCode : 0,
      });
      textarea.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    const update = async (text: string) => {
      textarea.value = text;
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
      await settle();
    };
    (window as any).__ime = { terminal, socket, inputs, textarea, key, settle, update };
  }, { iosLike, ready });
}

test('iOS 按真实 keyup 键码补发空格和标点，xterm 已发送时不重复', async ({ page }) => {
  await mountTerminal(page);
  const sent = await page.evaluate(async () => {
    const { inputs, textarea, key, settle } = (window as any).__ime;
    const delayed = async (before: string, after: string, text: string, keyupCode: number) => {
      textarea.value = before;
      key('keydown', text, 229);
      // Safari may update the textarea only after xterm's keydown timer has run.
      await settle();
      textarea.value = after;
      key('keyup', text, keyupCode);
      await settle();
    };
    await delayed('', ' ', ' ', 32);
    await delayed(' ', ' .', '.', 190);
    await delayed(' .', ' .、', '、', 0);
    await delayed(' .、', ' .、 ', ' ', 32);
    await delayed(' .、 ', ' .、。', ' ', 32);

    key('keydown', '！', 229);
    textarea.value = ' .、。！';
    await settle(); // Real xterm onData handles this character first.
    key('keyup', '！', 0);
    await settle();
    return inputs;
  });
  expect(sent).toEqual([' ', '.', '、', ' ', '\x7f。', '！']);
});

for (const iosLike of [true, false]) {
  for (const endBeforeEnter of [false, true]) {
    test(`${iosLike ? 'iOS' : 'macOS'} 组词不发送拼音、确认 Enter 不执行、下次 Enter 正常执行（先结束组词=${endBeforeEnter}）`, async ({ page }) => {
      await mountTerminal(page, iosLike);
      const result = await page.evaluate(async (endBeforeEnter) => {
        const { inputs, textarea, key, settle, update } = (window as any).__ime;
        key('keydown', 'n', 229);
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        await update('n');
        key('keyup', 'n', 229);
        for (const text of ['ni', 'ni h', 'ni hao']) {
          key('keydown', text.slice(-1), 229);
          await update(text);
          key('keyup', text.slice(-1), 0);
          await settle();
        }
        const intermediate = [...inputs];
        await update('你好');
        if (endBeforeEnter) {
          textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
        }
        // Safari can clear isComposing before the confirmation keydown; 229 is the fallback.
        const prevented = key('keydown', 'Enter', endBeforeEnter ? 229 : 13);
        if (!endBeforeEnter) {
          textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
        }
        key('keypress', 'Enter', 13);
        key('keyup', 'Enter', 13);
        await settle();
        const committed = [...inputs];
        // No 50/100ms cooldown: the next intentional Enter works immediately.
        key('keydown', 'Enter', 13);
        key('keyup', 'Enter', 13);
        return { intermediate, committed, final: [...inputs], prevented };
      }, endBeforeEnter);
      expect(result.intermediate).toEqual([]);
      expect(result.committed).toEqual(['你好']);
      expect(result.final).toEqual(['你好', '\r']);
      expect(result.prevented).toBe(false); // Let the browser/IME select its candidate.
    });
  }
}

test('中文提交后立即输入的延迟标点不丢失', async ({ page }) => {
  await mountTerminal(page);
  const sent = await page.evaluate(async () => {
    const { inputs, textarea, key, settle, update } = (window as any).__ime;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await update('你好');
    const now = Date.now;
    Date.now = () => 12345; // Keep the event sequence inside any former cooldown window.
    try {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
      await settle();
      key('keydown', '。', 229);
      await settle();
      textarea.value += '。';
      key('keyup', '。', 0);
      await settle();
      return inputs;
    } finally {
      Date.now = now;
    }
  });
  expect(sent).toEqual(['你好', '。']);
});

test('组词提交和标点补发仍受 Shell 就绪门控', async ({ page }) => {
  await mountTerminal(page, true, false);
  const sent = await page.evaluate(async () => {
    const { inputs, textarea, key, settle, update } = (window as any).__ime;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await update('你好');
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
    await settle();
    key('keydown', '。', 229);
    await settle();
    textarea.value += '。';
    key('keyup', '。', 0);
    await settle();
    return inputs;
  });
  expect(sent).toEqual([]);
});

test('通用文本对话框选词 Enter/Escape 不提交或关闭，普通 Enter 即时提交', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/');
  await page.evaluate(async () => {
    const { requestText } = await (window as any).eval("import('/src/ui-feedback.ts')");
    void requestText({ message: 'IME test' }).then((value: string | null) => {
      (window as any).__imePromptResult = value;
    });
  });
  const input = page.locator('#app-dialog-input');
  await expect(input).toBeVisible();
  const result = await input.evaluate((el: HTMLInputElement) => {
    const key = (key: string, keyCode: number) => el.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key, keyCode,
    }));
    el.value = 'nihao';
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    key('Enter', 13);
    key('Escape', 27);
    const during = el.closest('dialog')!.open;
    el.value = '你好';
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
    key('Enter', 229);
    const afterConfirm = el.closest('dialog')!.open;
    key('Enter', 13);
    return { during, afterConfirm };
  });
  expect(result).toEqual({ during: true, afterConfirm: true });
  await expect.poll(() => page.evaluate(() => (window as any).__imePromptResult)).toBe('你好');
});
