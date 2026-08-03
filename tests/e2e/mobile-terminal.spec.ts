import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('窄屏匿名连接表单不横向溢出且输入框避免 iOS 自动缩放', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  await expect(page.locator('#connection-form')).toBeVisible();
  const layout = await page.locator('#auth-section').evaluate((section) => {
    const hostInput = document.getElementById('host')!;
    const box = section.querySelector<HTMLElement>('.cyber-box')!;
    return {
      documentWidth: document.documentElement.scrollWidth,
      sectionWidth: section.scrollWidth,
      boxRight: Math.round(box.getBoundingClientRect().right),
      inputFontSize: getComputedStyle(hostInput).fontSize,
    };
  });

  expect(layout.documentWidth).toBe(320);
  expect(layout.sectionWidth).toBe(320);
  expect(layout.boxRight).toBeLessThanOrEqual(320);
  expect(layout.inputFontSize).toBe('16px');
});

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

  const primaryActions = await page.locator('#mobile-terminal-toolbar').evaluate((toolbar) => {
    const toolbarRect = toolbar.getBoundingClientRect();
    return ['mobile-copy-btn', 'mobile-paste-btn', 'mobile-keyboard-hide-btn'].map((id) => {
      const rect = document.getElementById(id)!.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        toolbarLeft: Math.round(toolbarRect.left),
        toolbarRight: Math.round(toolbarRect.right),
      };
    });
  });
  for (const action of primaryActions) {
    expect(action.left).toBeGreaterThanOrEqual(action.toolbarLeft);
    expect(action.right).toBeLessThanOrEqual(action.toolbarRight);
  }

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

test('终端字号随手机、触屏平板和桌面宽度调整且不受文本自动放大影响', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/');

  const initial = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'responsive-font-test-root';
    root.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:320px;';
    document.getElementById('terminal-area')?.appendChild(root);
    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    (window as any).__responsiveFontTerminal = terminal;
    const xterm = root.querySelector<HTMLElement>('.xterm')!;
    return {
      fontSize: (terminal as any).terminal.options.fontSize,
      textSizeAdjust: getComputedStyle(xterm).getPropertyValue('text-size-adjust')
        || getComputedStyle(xterm).getPropertyValue('-webkit-text-size-adjust'),
    };
  });

  expect(initial.fontSize).toBe(12);
  expect(initial.textSizeAdjust).toBe('100%');

  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => page.evaluate(() =>
    (window as any).__responsiveFontTerminal.terminal.options.fontSize,
  )).toBe(13);

  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(() => page.evaluate(() =>
    (window as any).__responsiveFontTerminal.terminal.options.fontSize,
  )).toBe(14);

  await page.evaluate(() => {
    (window as any).__responsiveFontTerminal.dispose();
    document.getElementById('responsive-font-test-root')?.remove();
  });
});

test('移动端 Agent 可返回终端且 SFTP 面板占满可用区域', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const dimensions = await page.evaluate(async () => {
    document.getElementById('auth-section')?.classList.add('hidden');
    const terminalSection = document.getElementById('terminal-section')!;
    terminalSection.classList.remove('hidden');
    terminalSection.classList.add('flex');
    document.body.classList.add('terminal-active');

    const agentModule = await (window as any).eval("import('/src/agent/agent-panel.ts')");
    const agent = new agentModule.AgentPanel(document.getElementById('terminal-area')!, true);
    agent.render();
    agent.show();
    (window as any).__mobileAgentPanel = agent;

    const sftp = document.createElement('div');
    sftp.id = 'sftp-panel';
    sftp.style.cssText = 'position:fixed;top:0;right:0;';
    document.body.appendChild(sftp);

    const agentElement = document.getElementById('agent-panel')!;
    const agentRect = agentElement.getBoundingClientRect();
    const headerRect = agentElement.querySelector('.agent-panel-header')!.getBoundingClientRect();
    const sftpRect = sftp.getBoundingClientRect();
    return {
      agentWidth: Math.round(agentRect.width),
      agentHeight: Math.round(agentRect.height),
      agentTop: Math.round(agentRect.top),
      agentHeaderTop: Math.round(headerRect.top),
      sftpWidth: Math.round(sftpRect.width),
      sftpHeight: Math.round(sftpRect.height),
    };
  });

  expect(dimensions.agentWidth).toBe(390);
  expect(dimensions.agentHeight).toBeGreaterThan(0);
  expect(dimensions.agentTop).toBe(48);
  expect(dimensions.agentHeaderTop).toBe(48);
  expect(dimensions.sftpWidth).toBe(390);
  expect(dimensions.sftpHeight).toBeGreaterThan(0);

  const backButton = page.locator('#agent-close-btn');
  await expect(backButton).toBeVisible();
  await expect(backButton).toContainText('返回终端');
  await expect(backButton).toHaveAttribute('title', '返回终端');
  await page.locator('#sftp-panel').evaluate((element) => element.remove());
  await backButton.click();
  await expect(page.locator('#agent-panel')).toBeHidden();
  await expect(page.locator('#terminal-wrapper')).toBeVisible();
});

test('iOS keyCode 229 在 keyup 后准确补发输入法文本和多字符删除', async ({ page }) => {
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

    textarea.value = 'abc';
    textarea.dispatchEvent(keyEvent('keydown'));
    textarea.value = 'a';
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

  expect(sent).toEqual(['。', '\x7f\x7f']);
});
