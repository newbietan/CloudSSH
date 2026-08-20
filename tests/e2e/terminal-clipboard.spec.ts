import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test('终端只在正常结束鼠标选区时自动复制', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-clipboard-test-root';
    root.style.width = '800px';
    root.style.height = '320px';
    document.body.appendChild(root);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const copiedTexts: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedTexts.push(text);
        },
      },
    });

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const xterm = (terminal as any).terminal;
    await new Promise<void>((resolve) => xterm.write('hello', resolve));
    xterm.select(0, 0, 5);

    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
      })
    );
    window.dispatchEvent(new PointerEvent('pointercancel', { button: 0 }));
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const copiedAfterCancel = copiedTexts.length;

    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        button: 0,
        clientX: 80,
        clientY: 20,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toast = document.querySelector<HTMLElement>('.app-toast');
    const output = {
      copiedAfterCancel,
      copiedTexts: [...copiedTexts],
      toastText: toast?.textContent || '',
      toastVariant: toast?.dataset.variant || '',
    };

    terminal.dispose();
    root.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as any).clipboard;
    }
    return output;
  });

  expect(result.copiedAfterCancel).toBe(0);
  expect(result.copiedTexts).toEqual(['hello']);
  expect(result.toastText).toContain('已复制');
  expect(result.toastVariant).toBe('success');
});

test('移动端通过选择模式拖动生成选区并显式复制', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const mobileModule = await (window as any).eval("import('/src/mobile-terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-touch-copy-test-root';
    root.style.cssText = 'width:390px;height:320px;';
    document.body.appendChild(root);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const copiedTexts: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => copiedTexts.push(text) },
    });

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const mobileController = new mobileModule.MobileTerminalController(() => terminal);
    mobileController.start();
    const xterm = (terminal as any).terminal;
    await new Promise<void>((resolve) => xterm.write('touch selection', resolve));

    const copyButton = document.getElementById('mobile-copy-btn')!;
    copyButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const selectionModeEnabled = terminal.isMobileSelectionMode();

    const screen = root.querySelector<HTMLElement>('.xterm-screen')!;
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / xterm.cols;
    const cellHeight = rect.height / xterm.rows;
    const pointerId = 7;
    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 0.5,
        clientY: rect.top + cellHeight * 0.5,
      })
    );
    root.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 4.5,
        clientY: rect.top + cellHeight * 0.5,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 4.5,
        clientY: rect.top + cellHeight * 0.5,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const selectionBeforeCopy = xterm.getSelection();
    const copiedBeforeButton = [...copiedTexts];
    copyButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = {
      copiedTexts,
      copiedBeforeButton,
      selectionBeforeCopy,
      selectionAfterCopy: xterm.getSelection(),
      selectionModeEnabled,
      selectionModeAfterCopy: terminal.isMobileSelectionMode(),
      copyButtonPressed: copyButton.getAttribute('aria-pressed'),
    };
    terminal.dispose();
    root.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as any).clipboard;
    }
    return output;
  });

  expect(result.selectionModeEnabled).toBe(true);
  expect(result.selectionBeforeCopy).toBe('touch');
  expect(result.copiedBeforeButton).toEqual([]);
  expect(result.copiedTexts).toEqual(['touch']);
  expect(result.selectionAfterCopy).toBe('');
  expect(result.selectionModeAfterCopy).toBe(false);
  expect(result.copyButtonPressed).toBe('false');
});

test('旧版复制回退准确返回结果并恢复原焦点', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const clipboardModule = await (window as any).eval("import('/src/clipboard.ts')");
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => true,
    });
    const copied = clipboardModule.copyTextWithExecCommand('hello');
    const focusedAfterSuccess = document.activeElement === input;

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    });
    const rejected = clipboardModule.copyTextWithExecCommand('hello');
    const focusedAfterFailure = document.activeElement === input;

    const originalSelect = HTMLTextAreaElement.prototype.select;
    HTMLTextAreaElement.prototype.select = () => {
      throw new Error('selection unavailable');
    };
    const failedDuringSelection = clipboardModule.copyTextWithExecCommand('hello');
    const temporaryTextareas = document.querySelectorAll(
      'textarea[aria-hidden="true"][tabindex="-1"]'
    ).length;
    const focusedAfterSelectionError = document.activeElement === input;
    HTMLTextAreaElement.prototype.select = originalSelect;

    input.remove();
    if (execCommandDescriptor) {
      Object.defineProperty(document, 'execCommand', execCommandDescriptor);
    } else {
      delete (document as any).execCommand;
    }

    return {
      copied,
      rejected,
      failedDuringSelection,
      temporaryTextareas,
      focusedAfterSuccess,
      focusedAfterFailure,
      focusedAfterSelectionError,
    };
  });

  expect(result).toEqual({
    copied: true,
    rejected: false,
    failedDuringSelection: false,
    temporaryTextareas: 0,
    focusedAfterSuccess: true,
    focusedAfterFailure: true,
    focusedAfterSelectionError: true,
  });
});

test('右键粘贴遵循终端的 bracketed paste 模式并统一换行', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-paste-test-root';
    root.style.width = '800px';
    root.style.height = '320px';
    document.body.appendChild(root);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'one\r\ntwo\n' },
    });

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const xterm = (terminal as any).terminal;
    (terminal as any).ws = {
      readyState: WebSocket.OPEN,
      close: () => undefined,
    };
    (terminal as any).sessionReady = true;
    const pasted: string[] = [];
    const inputDisposable = xterm.onData((data: string) => pasted.push(data));

    await new Promise<void>((resolve) => xterm.write('\x1b[?2004h', resolve));
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bracketed = pasted.join('');

    pasted.length = 0;
    await new Promise<void>((resolve) => xterm.write('\x1b[?2004l', resolve));
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const plain = pasted.join('');

    inputDisposable.dispose();
    terminal.dispose();
    root.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as any).clipboard;
    }
    return { bracketed, plain };
  });

  expect(result.bracketed).toBe('\x1b[200~one\rtwo\r\x1b[201~');
  expect(result.plain).toBe('one\rtwo\r');
});
