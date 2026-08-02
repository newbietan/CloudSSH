import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('移动端终端使用紧凑布局并提供完整快捷键入口', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  await page.evaluate(() => {
    document.getElementById('auth-section')?.classList.add('hidden');
    const section = document.getElementById('terminal-section')!;
    section.classList.remove('hidden');
    section.classList.add('flex');
    document.body.classList.add('terminal-active');
  });

  await expect(page.locator('#mobile-terminal-toolbar')).toBeVisible();
  await expect(page.locator('#theme-selector')).toBeHidden();
  await expect(page.locator('.terminal-footer')).toBeHidden();
  await expect(page.locator('[data-mobile-modifier="ctrl"]')).toBeVisible();
  await expect(page.locator('[data-terminal-key="escape"]')).toBeVisible();
  await expect(page.locator('#mobile-copy-btn')).toBeVisible();
  await expect(page.locator('#mobile-paste-btn')).toBeVisible();

  await page.locator('#mobile-more-btn').click();
  await expect(page.locator('#mobile-more-menu')).toBeVisible();
  await expect(page.locator('#mobile-landscape-btn')).toContainText('全屏横屏');
  await page.evaluate(() => {
    (window as any).__fullscreenTarget = '';
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: async function requestFullscreen(this: HTMLElement) {
        (window as any).__fullscreenTarget = this.tagName;
      },
    });
  });
  await page.locator('#mobile-landscape-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).__fullscreenTarget)).toBe('HTML');

  const terminalHeight = await page.locator('#terminal-section').evaluate((element) =>
    Math.round(element.getBoundingClientRect().height),
  );
  expect(terminalHeight).toBeGreaterThan(0);
  expect(terminalHeight).toBeLessThanOrEqual(844);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#mobile-terminal-toolbar')).toBeVisible();
  await expect(page.locator('#theme-selector')).toBeHidden();
});

test('移动端 Agent 和 SFTP 面板占满终端可用区域', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/');

  const dimensions = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;';
    const agent = document.createElement('div');
    agent.id = 'agent-panel';
    agent.style.display = 'flex';
    host.appendChild(agent);
    document.body.appendChild(host);

    const sftp = document.createElement('div');
    sftp.id = 'sftp-panel';
    sftp.style.cssText = 'position:fixed;top:0;right:0;';
    document.body.appendChild(sftp);

    const agentRect = agent.getBoundingClientRect();
    const sftpRect = sftp.getBoundingClientRect();
    return {
      agentWidth: Math.round(agentRect.width),
      agentHeight: Math.round(agentRect.height),
      sftpWidth: Math.round(sftpRect.width),
      sftpHeight: Math.round(sftpRect.height),
    };
  });

  expect(dimensions.agentWidth).toBe(390);
  expect(dimensions.agentHeight).toBeGreaterThan(0);
  expect(dimensions.sftpWidth).toBe(390);
  expect(dimensions.sftpHeight).toBeGreaterThan(0);
});

test('iOS keyCode 229 在 keyup 后只补发一次输入法文本', async ({ page }) => {
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
    const textarea = root.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const keyEvent = (type: 'keydown' | 'keyup') => {
      const event = new KeyboardEvent(type, { bubbles: true, key: '。' });
      Object.defineProperty(event, 'keyCode', { value: 229 });
      return event;
    };
    textarea.value = '';
    textarea.dispatchEvent(keyEvent('keydown'));
    textarea.value = '。';
    textarea.dispatchEvent(keyEvent('keyup'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    terminal.dispose();
    root.remove();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(navigator, key, descriptor);
      else delete (navigator as any)[key];
    }
    return payloads;
  });

  expect(sent).toEqual(['。']);
});
