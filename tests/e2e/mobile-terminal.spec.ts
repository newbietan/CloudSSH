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
  // 必须等匿名会话真实渲染完成再做手工 DOM 提示：init() 在 /api/auth/me 返回后
  // 会调用 showAuthSection() → deactivateTerminalView() 重新隐藏 #terminal-section，
  // 若早于该时机提升就会偶发被覆盖（并行执行时表现为 #mobile-terminal-toolbar 隐藏）。
  await expect(page.locator('#connection-form')).toBeVisible();

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

  const terminalHeight = await page
    .locator('#terminal-section')
    .evaluate((element) => Math.round(element.getBoundingClientRect().height));
  expect(terminalHeight).toBeGreaterThan(0);
  expect(terminalHeight).toBeLessThanOrEqual(844);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#mobile-terminal-toolbar')).toBeVisible();
  await expect(page.locator('#theme-selector')).toBeHidden();
});

test('软键盘动画使用可视视口并只在尺寸稳定后适配终端', async ({ page }) => {
  await page.addInitScript(() => {
    class TestVisualViewport extends EventTarget {
      width = 390;
      height = 844;
      offsetLeft = 0;
      offsetTop = 0;
      pageLeft = 0;
      pageTop = 0;
      scale = 1;
    }
    const viewport = new TestVisualViewport();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    (window as any).__setTestVisualViewport = (height: number, offsetTop: number) => {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  });
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#connection-form')).toBeVisible();

  const result = await page.evaluate(async () => {
    document.getElementById('auth-section')?.classList.add('hidden');
    const section = document.getElementById('terminal-section')!;
    section.classList.remove('hidden');
    section.classList.add('flex');
    document.body.classList.add('terminal-active');

    const mobileModule = await (window as any).eval("import('/src/mobile-terminal.ts')");
    let fitCount = 0;
    const terminal = {
      fit: () => {
        fitCount += 1;
      },
      getMobileModifier: () => null,
      isMobileSelectionMode: () => false,
      setMobileSelectionMode: () => undefined,
    };
    const controller = new mobileModule.MobileTerminalController(() => terminal);
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 160));
    fitCount = 0;

    (window as any).__setTestVisualViewport(720, 4);
    (window as any).__setTestVisualViewport(610, 8);
    (window as any).__setTestVisualViewport(500, 12);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const fitCountDuringAnimation = fitCount;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const rootStyle = document.documentElement.style;
    const sectionRect = section.getBoundingClientRect();
    return {
      fitCountDuringAnimation,
      finalFitCount: fitCount,
      viewportHeight: rootStyle.getPropertyValue('--visual-viewport-height'),
      viewportOffsetTop: rootStyle.getPropertyValue('--visual-viewport-offset-top'),
      keyboardOpen: document.documentElement.classList.contains('mobile-keyboard-open'),
      statusHidden: getComputedStyle(document.querySelector('.terminal-status-bar')!).display,
      sectionTop: Math.round(sectionRect.top),
      sectionHeight: Math.round(sectionRect.height),
    };
  });

  expect(result.fitCountDuringAnimation).toBe(0);
  expect(result.finalFitCount).toBe(1);
  expect(result.viewportHeight).toBe('500px');
  expect(result.viewportOffsetTop).toBe('12px');
  expect(result.keyboardOpen).toBe(true);
  expect(result.statusHidden).toBe('none');
  expect(result.sectionTop).toBe(12);
  expect(result.sectionHeight).toBe(500);
});

test('移动端可单指滑动终端历史且调整尺寸后保留阅读位置', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'mobile-scroll-test-root';
    root.style.cssText = 'position:fixed;left:0;top:0;width:390px;height:320px;';
    document.body.appendChild(root);
    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const xterm = (terminal as any).terminal;
    const lines = Array.from({ length: 120 }, (_, index) => `line ${index}\r\n`).join('');
    await new Promise<void>((resolve) => xterm.write(lines, resolve));
    xterm.scrollToBottom();

    const initial = {
      baseY: xterm.buffer.active.baseY,
      viewportY: xterm.buffer.active.viewportY,
    };
    root.style.height = '280px';
    terminal.fit();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bottomAfterFit = {
      baseY: xterm.buffer.active.baseY,
      viewportY: xterm.buffer.active.viewportY,
    };

    root.style.height = '320px';
    terminal.fit();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const screen = root.querySelector<HTMLElement>('.xterm-screen')!;
    const rect = screen.getBoundingClientRect();
    const pointerId = 74;
    const dispatchTouch = (target: EventTarget, type: string, x: number, y: number) => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerType: 'touch',
          pointerId,
          clientX: x,
          clientY: y,
        })
      );
    };

    dispatchTouch(screen, 'pointerdown', rect.left + 100, rect.top + 80);
    dispatchTouch(screen, 'pointermove', rect.left + 101, rect.top + 155);
    dispatchTouch(window, 'pointerup', rect.left + 101, rect.top + 155);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterSwipe = {
      baseY: xterm.buffer.active.baseY,
      viewportY: xterm.buffer.active.viewportY,
    };

    const distanceBeforeFit = afterSwipe.baseY - afterSwipe.viewportY;
    root.style.height = '240px';
    terminal.fit();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const distanceAfterFit = xterm.buffer.active.baseY - xterm.buffer.active.viewportY;

    const beforeTap = xterm.buffer.active.viewportY;
    dispatchTouch(screen, 'pointerdown', rect.left + 100, rect.top + 80);
    dispatchTouch(window, 'pointerup', rect.left + 100, rect.top + 80);
    const afterTap = xterm.buffer.active.viewportY;

    terminal.dispose();
    root.remove();
    return {
      initial,
      afterSwipe,
      distanceBeforeFit,
      distanceAfterFit,
      beforeTap,
      afterTap,
      bottomAfterFit,
    };
  });

  expect(result.initial.baseY).toBeGreaterThan(0);
  expect(result.initial.viewportY).toBe(result.initial.baseY);
  expect(result.afterSwipe.viewportY).toBeLessThan(result.afterSwipe.baseY);
  expect(result.distanceAfterFit).toBe(result.distanceBeforeFit);
  expect(result.afterTap).toBe(result.beforeTap);
  expect(result.bottomAfterFit.viewportY).toBe(result.bottomAfterFit.baseY);
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
      textSizeAdjust:
        getComputedStyle(xterm).getPropertyValue('text-size-adjust') ||
        getComputedStyle(xterm).getPropertyValue('-webkit-text-size-adjust'),
    };
  });

  expect(initial.fontSize).toBe(12);
  expect(initial.textSizeAdjust).toBe('100%');

  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => (window as any).__responsiveFontTerminal.fit());
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__responsiveFontTerminal.terminal.options.fontSize)
    )
    .toBe(13);

  await page.setViewportSize({ width: 1200, height: 800 });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__responsiveFontTerminal.terminal.options.fontSize)
    )
    .toBe(14);

  await page.evaluate(() => {
    (window as any).__responsiveFontTerminal.dispose();
    document.getElementById('responsive-font-test-root')?.remove();
  });
});

test('移动端 Agent 可返回终端且 SFTP 面板占满可用区域', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#connection-form')).toBeVisible();

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

  // 移动端打开 Agent 面板时，底部的终端快捷键工具栏应自动隐藏，防止遮挡输入框
  await expect(page.locator('#mobile-terminal-toolbar')).toBeHidden();

  const backButton = page.locator('#agent-close-btn');
  await expect(backButton).toBeVisible();
  await expect(backButton).toContainText('返回终端');
  await expect(backButton).toHaveAttribute('title', '返回终端');
  await expect(backButton).toHaveAttribute('aria-label', '返回终端');
  await page.locator('#sftp-panel').evaluate((element) => element.remove());
  await backButton.click();
  await expect(page.locator('#agent-panel')).toBeHidden();
  await expect(page.locator('#terminal-wrapper')).toBeVisible();

  // 返回终端后，终端快捷键工具栏应重新显示
  await expect(page.locator('#mobile-terminal-toolbar')).toBeVisible();
});

/**
 * 移动端抽屉入口回归：
 *
 * e406aa4 把 SFTP / 自定义命令 / AI Agent 三个抽屉按钮收进
 * #terminal-drawer-segmented-bar，并给该容器加了 .desktop-terminal-action
 * （移动端 display: none !important）。但当时没有在 #mobile-more-menu 里补平行入口，
 * 于是移动端用户彻底失去了 SFTP 与 AI Agent 的打开方式（分段条整体被隐藏）。
 *
 * 本用例锁定两条不变式：
 * 1. 移动端分段条隐藏时，菜单里必须存在 SFTP 与 AI Agent 的平行入口；
 * 2. 登录后 #mobile-agent-btn 的解锁状态必须与桌面 #agent-toggle-btn 同步。
 */
test('移动端保留 SFTP 与 AI Agent 抽屉入口，分段条为桌面专属', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto(
    `/?wsUrl=${encodeURIComponent('ws://127.0.0.1:4173/fake')}&name=Drawer&host=127.0.0.1&port=22&lang=zh-CN`
  );
  await expect(page.locator('.terminal-app-header')).toBeVisible();

  // 分段切换器在移动端整体隐藏，因此入口必须来自移动端菜单
  await expect(page.locator('#terminal-drawer-segmented-bar')).toBeHidden();

  await page.locator('#mobile-more-btn').click();
  await expect(page.locator('#mobile-more-menu')).toBeVisible();
  await expect(page.locator('#mobile-sftp-btn')).toBeVisible();
  await expect(page.locator('#mobile-snippets-btn')).toBeVisible();
  // 匿名模式不提供 AI Agent（与桌面 #agent-toggle-btn 初始 hidden 一致）
  await expect(page.locator('#mobile-agent-btn')).toBeHidden();
  await expect(page.locator('#agent-toggle-btn')).toHaveClass(/hidden/);
});

test('登录后移动端 AI Agent 入口与桌面按钮同步解锁', async ({ page }) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 42, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#user-space-more-btn')).toBeVisible();

  await expect(page.locator('#agent-toggle-btn')).not.toHaveClass(/hidden/);
  await expect(page.locator('#mobile-agent-btn')).not.toHaveClass(/hidden/);
});
