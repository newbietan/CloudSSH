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

    root.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    }));
    window.dispatchEvent(new PointerEvent('pointercancel', { button: 0 }));
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const copiedAfterCancel = copiedTexts.length;

    root.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', {
      button: 0,
      clientX: 80,
      clientY: 20,
    }));
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

    input.remove();
    if (execCommandDescriptor) {
      Object.defineProperty(document, 'execCommand', execCommandDescriptor);
    } else {
      delete (document as any).execCommand;
    }

    return { copied, rejected, focusedAfterSuccess, focusedAfterFailure };
  });

  expect(result).toEqual({
    copied: true,
    rejected: false,
    focusedAfterSuccess: true,
    focusedAfterFailure: true,
  });
});
