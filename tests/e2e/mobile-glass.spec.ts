import { expect, test, type Page } from './fixtures';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function setup(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github' } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [{ id: 1, user_id: 1, name: 'Glass preview', host: 'preview.example.com', port: 22, username: 'tester', auth_method: 'password', tags: [], created_at: '', updated_at: '' }] }) : route.fallback());
  await page.route('**/api/mcp/config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { configured: false, id: null, grants: [], hasAccessCredentials: false, legacy: false } }) : route.fallback());
  await page.route('**/api/servers/1/memory', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { workLogs: [], knowledge: [] } }) : route.fallback());
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#user-space-section')).toBeVisible();
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
}

async function applyTheme(page: Page, name: string) {
  await page.evaluate(async (name) => {
    const path = '/src/theme.ts';
    const { applyBuiltInTheme } = await import(path);
    applyBuiltInTheme(name);
  }, name);
}

// Style probes exercise the real selectors without opening several mutually exclusive dialogs.
// Actual menus, drawers and dialogs are rendered separately in the visual scenario below.
async function surfaceAlphas(page: Page) {
  return page.locator('#glass-style-probes').evaluate((root) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    return Object.fromEntries([...root.children].map((node) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = getComputedStyle(node).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return [node.getAttribute('data-probe'), ctx.getImageData(0, 0, 1, 1).data[3]];
    }));
  });
}

test('玻璃阅读表面仅在移动断点增厚，主题切换和桌面恢复不残留覆盖', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'glass-style-probes'; root.hidden = true;
    for (const [name, id, className] of [
      ['card', '', 'server-card'], ['box', '', 'cyber-box'],
      ['settings', '', 'responsive-modal-panel cyber-box'],
      ['confirm', '', 'app-dialog__panel'], ['auth', '', 'auth-challenge-dialog__panel'],
      ['editor', '', 'remote-editor__panel'], ['mcp', '', 'mcp-dialog__panel assistant-shell'],
      ['agent', 'agent-panel', 'assistant-shell'], ['sftp', 'sftp-panel', ''],
      ['snippets', 'snippet-panel', ''], ['menu', '', 'mobile-more-menu'],
      ['userMenu', '', 'user-space-header-actions'],
      ['tabMenu', 'tab-context-menu', 'cyber-box'], ['modelMenu', 'ai-model-menu', 'cyber-box'],
      ['fileMenu', 'sftp-context-menu', 'bg-elevated'],
    ]) {
      const node = document.createElement('div');
      node.dataset.probe = name; node.id = id; node.className = className;
      root.appendChild(node);
    }
    document.body.appendChild(root);
  });
  await page.setViewportSize({ width: 1280, height: 844 });
  await applyTheme(page, 'liquid-glass');
  const desktop = await surfaceAlphas(page);
  expect(desktop.card).toBeLessThan(80);
  expect(desktop.confirm).toBeLessThan(90);
  expect(desktop.sftp).toBeLessThan(190);
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [name, alpha] of Object.entries(await surfaceAlphas(page))) {
      expect(alpha, `${name} at ${width}px`).toBe(name === 'card' || name === 'box' ? 250 : 255);
    }
  }
  for (const theme of ['standard-dark', 'standard-light', 'cyberpunk']) {
    await applyTheme(page, theme);
    const inherited = await page.evaluate(() => ['--bg-surface', '--bg-elevated'].every((key) =>
      getComputedStyle(document.body).getPropertyValue(key) === getComputedStyle(document.documentElement).getPropertyValue(key)));
    expect(inherited, `${theme}: keep original palette`).toBe(true);
  }
  await applyTheme(page, 'liquid-glass');
  await page.setViewportSize({ width: 1280, height: 844 });
  expect(await surfaceAlphas(page)).toEqual(desktop);
});

test('移动玻璃菜单、弹窗及抽屉在终端文字背景上保持清晰', async ({ page }) => {
  await setup(page);
  const capture = async (name: string) => {
    const path = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await test.info().attach(name, { path, contentType: 'image/png' });
  };
  await page.locator('#user-space-more-btn').click();
  await page.locator('#user-theme-selector').selectOption('liquid-glass');
  await expect(page.locator('#user-space-header-actions')).toBeHidden();
  await page.locator('#user-space-more-btn').click();
  await capture('user-menu');
  await page.locator('#user-space-more-btn').click();
  await expect(page.locator('#user-space-header-actions')).toBeHidden();
  await page.locator('#add-server-btn').click();
  await expect(page.locator('#server-modal')).toBeVisible();
  await capture('server-form');
  await page.locator('#modal-close-btn').click();
  await page.evaluate(async () => {
    const path = '/src/main.ts';
    const { showTerminalWithNewTab } = await import(path);
    const { terminal } = showTerminalWithNewTab('Glass preview');
    await new Promise<void>(resolve => terminal.terminal.write(
      Array.from({ length: 36 }, (_, i) => `${i.toString().padStart(2, '0')} nginx active  CPU 12%  memory 42%\r\n`).join(''), resolve));
  });
  await page.locator('#mobile-more-btn').click();
  await expect(page.locator('#mobile-more-menu')).toBeVisible();
  await capture('terminal-menu');
  const clip = await page.locator('#mobile-more-menu').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const inset = Math.ceil(Number.parseFloat(getComputedStyle(el).borderTopLeftRadius)) + 4;
    // Compare the opaque reading area, excluding the decorative rim and rounded corners.
    return { x: Math.ceil(box.left) + 12, y: Math.ceil(box.top) + inset,
      width: Math.floor(box.width) - 24, height: Math.floor(box.height) - 2 * inset };
  });
  const withOutput = await page.screenshot({ clip, animations: 'disabled' });
  await page.locator('.xterm-screen').evaluate((el) => { (el as HTMLElement).style.visibility = 'hidden'; });
  const withoutOutput = await page.screenshot({ clip, animations: 'disabled' });
  await page.locator('.xterm-screen').evaluate((el) => { (el as HTMLElement).style.visibility = ''; });
  expect(withOutput.equals(withoutOutput), 'terminal output must not paint through the menu').toBe(true);
  await page.locator('#mobile-more-menu [data-mcp-open]').click();
  await expect(page.locator('#mcp-config-form')).toBeVisible();
  await capture('mcp');
  await page.keyboard.press('Escape');
  await expect(page.locator('#mcp-dialog')).not.toBeAttached();
  await page.evaluate(async () => {
    const path = '/src/ui-feedback.ts';
    const { confirmAction } = await import(path);
    void confirmAction({ title: '确认操作', message: '此处只验证弹窗的可读性，不执行远端操作。' });
  });
  await expect(page.locator('.app-dialog__panel')).toBeVisible();
  await capture('confirmation');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const path = '/src/sftp-panel.ts';
    const { SFTPPanel } = await import(path);
    const panel = new SFTPPanel(() => null);
    panel.bindEvents(); panel.visible = true; panel.sftpReady = true;
    panel.container.style.transform = 'translateX(0)';
    panel.handleMessage({ type: 'sftp_list_result', path: '/var/log', entries: Array.from({ length: 8 }, (_, i) => ({
      name: `service-${i}.log`, type: 'file', isDir: false, isLink: false,
      size: 1234, sizeFormatted: '1.2 KB', permissions: '-rw-r--r--', permissionsRaw: 0o100644, modifiedTime: 1,
    })) });
    (window as any).__glassSftp = panel;
  });
  await expect(page.locator('#sftp-entries')).toBeVisible();
  await capture('sftp');
  await page.evaluate(async () => {
    (window as any).__glassSftp.dispose();
    const path = '/src/agent/agent-panel.ts';
    const { AgentPanel } = await import(path);
    const panel = new AgentPanel(document.body, true, 1, 42);
    const sent: any[] = [];
    panel.render(); panel.show();
    panel.setWebSocketSend((data: string) => sent.push(JSON.parse(data)));
    panel.sendMessage('查看当前系统状态');
    const requestId = sent.at(-1).requestId;
    const content = '## 状态概览\n\nCPU 负载正常，内存占用约 42%。\n\n- 服务运行正常\n- 暂未发现端口异常\n\n```shell\nsystemctl status nginx\n```';
    panel.handleAgentFrame({ subType: 'run_start', runId: 1, requestId });
    panel.handleAgentFrame({ subType: 'stream_chunk', runId: 1, requestId, content });
    panel.handleAgentFrame({ subType: 'stream_end', runId: 1, requestId, content });
    panel.handleAgentFrame({ subType: 'run_end', runId: 1, requestId, outcome: 'completed' });
  });
  await expect(page.locator('#agent-panel')).toBeVisible();
  await expect(page.locator('#agent-quick-chips')).toBeHidden();
  await capture('agent');
});
