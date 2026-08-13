import { expect, test, type Page } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Playwright WebKit 的 iPhone 设备描述目前仍报告 maxTouchPoints=0，
    // 与真实 iOS Safari 不一致；在测试夹具中补齐触控能力。
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && navigator.maxTouchPoints === 0) {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        value: 5,
      });
    }

    interface TestSocketState {
      url: string;
      sent: unknown[];
      ready: boolean;
    }

    class TestWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = TestWebSocket.CONNECTING;
      binaryType = 'blob';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private readonly state: TestSocketState;

      constructor(url: string | URL) {
        this.url = String(url);
        this.state = { url: this.url, sent: [], ready: false };
        if (this.url.includes('/api/ssh')) {
          (window as any).__testSockets.push(this.state);
        }
        setTimeout(() => {
          this.readyState = TestWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        }, 0);
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        let message: any = data;
        if (typeof data === 'string') {
          try { message = JSON.parse(data); } catch { /* terminal input */ }
        }
        this.state.sent.push(message);

        if (message?.type === 'ping') {
          setTimeout(() => this.emitJSON({ type: 'pong', id: message.id }), 0);
          return;
        }
        if (message?.type === 'resize' && !this.state.ready) {
          this.state.ready = true;
          setTimeout(() => {
            this.emitJSON({ type: 'status', event: 'auth_success', message: '认证成功' });
            this.emitJSON({ type: 'status', event: 'shell_ready', message: 'Shell 已就绪' });
          }, 0);
        }
      }

      close(code = 1000, reason = ''): void {
        if (this.readyState === TestWebSocket.CLOSED) return;
        this.readyState = TestWebSocket.CLOSED;
        setTimeout(() => this.onclose?.(new CloseEvent('close', {
          code,
          reason,
          wasClean: code === 1000,
        })), 0);
      }

      private emitJSON(message: unknown): void {
        if (this.readyState !== TestWebSocket.OPEN) return;
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
      }
    }

    (window as any).__testSockets = [];
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TestWebSocket,
    });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (window as any).__testVisibilityState ?? 'visible',
    });
  });

  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      turnstileEnabled: false,
      sitekey: '',
      githubAuthEnabled: true,
      githubAuthRequired: false,
    }),
  }));
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 1, github_id: 42, username: 'tester', avatar_url: '' }),
  }));
  await page.route('**/api/user/theme', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"theme":null}',
  }));
  await page.route('**/api/servers', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: 7,
      user_id: 1,
      name: 'Mobile VPS',
      host: 'vps.example.com',
      port: 22,
      username: 'root',
      auth_method: 'password',
      tags: [],
      created_at: '2026-08-12T00:00:00Z',
      updated_at: '2026-08-12T00:00:00Z',
    }]),
  }));
});

async function simulateBackgroundReturn(page: Page): Promise<{ output: string; sent: unknown[] }> {
  return page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = `resume-test-${crypto.randomUUID()}`;
    root.style.cssText = 'position:fixed;inset:0;width:390px;height:320px;';
    document.body.appendChild(root);

    const sent: unknown[] = [];
    const written: string[] = [];
    const terminal = new terminalModule.SSHTerminal(root.id) as any;
    terminal.mount();
    const originalWriteln = terminal.terminal.writeln.bind(terminal.terminal);
    terminal.terminal.writeln = (data: string) => {
      written.push(data);
      originalWriteln(data);
    };
    terminal.ws = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        try { sent.push(JSON.parse(data)); } catch { sent.push(data); }
      },
      close: () => undefined,
    };

    (window as any).__testVisibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    (window as any).__testVisibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 50));

    terminal.dispose();
    root.remove();
    delete (window as any).__testVisibilityState;
    return { output: written.join('\n'), sent };
  });
}

test('移动触控环境回到前台时检查 SSH 连接', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  const result = await simulateBackgroundReturn(page);

  expect(result.output).toContain('页面已回到前台，正在检查 SSH 连接');
  expect(result.sent).toContainEqual(expect.objectContaining({ type: 'ping' }));
});

test.describe('桌面端页面切换', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });

  test('不触发移动端 SSH 恢复检查', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', '桌面端回归由 Desktop Chrome 项目覆盖');
    await page.goto('/?lang=zh-CN');

    const result = await simulateBackgroundReturn(page);

    expect(result.output).not.toContain('页面已回到前台，正在检查 SSH 连接');
    expect(result.sent).not.toContainEqual(expect.objectContaining({ type: 'ping' }));
  });
});

test('手机回到前台后淘汰僵尸连接并为保存服务器刷新令牌', async ({ page }) => {
  let connectRequests = 0;
  await page.route('**/api/servers/7/connect', (route) => {
    connectRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ wsUrl: `ws://127.0.0.1:4173/api/ssh?token=42:test-${connectRequests}` }),
    });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#connect-7').click();
  await expect(page.locator('#terminal-section')).toBeVisible();
  await expect(page.locator('#term-status')).toContainText('已连接');
  expect(connectRequests).toBe(1);

  const beforeRecovery = await page.evaluate(() => {
    const mainModule = (window as any).eval("import('/src/main.ts')");
    return mainModule.then((module: any) => {
      const terminal = module.getTabManager().getActiveTab().terminal as any;
      const socket = terminal.ws;
      terminal.recoverUnresponsiveConnection(socket);
      return {
        state: module.getTabManager().getActiveTab().state,
        socketCount: (window as any).__testSockets.length,
      };
    });
  });

  expect(beforeRecovery).toEqual({ state: 'connecting', socketCount: 1 });
  await expect(page.locator('#term-status')).toContainText('连接中');
  await expect.poll(() => connectRequests, { timeout: 5_000 }).toBe(2);
  await expect(page.locator('#term-status')).toContainText('已连接');

  const recovered = await page.evaluate(() => ({
    sockets: (window as any).__testSockets,
  }));
  expect(recovered.sockets).toHaveLength(2);
  expect(recovered.sockets[0].url).toContain('token=42:test-1');
  expect(recovered.sockets[1].url).toContain('token=42:test-2');
});

test('主机指纹变更必须明确确认后更新精确路由并刷新保存服务器令牌', async ({ page }) => {
  const oldFingerprint = `SHA256:${'A'.repeat(43)}`;
  const newFingerprint = `SHA256:${'B'.repeat(43)}`;
  const routeIdentity = 'jump:7@bastion.example.com:22|vps.example.com';
  let connectRequests = 0;
  const knownHostUpdates: Array<Record<string, unknown>> = [];

  await page.route('**/api/servers/7/connect', (route) => {
    connectRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ wsUrl: `ws://127.0.0.1:4173/api/ssh?token=42:host-key-${connectRequests}` }),
    });
  });
  await page.route('**/api/known-hosts', async (route) => {
    if (route.request().method() === 'POST') {
      knownHostUpdates.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#connect-7').click();
  await expect(page.locator('#term-status')).toContainText('已连接');

  await page.evaluate(({ oldFingerprint, newFingerprint, routeIdentity }) => {
    void (window as any).eval("import('/src/main.ts')").then((module: any) => {
      const terminal = module.getTabManager().getActiveTab().terminal as any;
      const socket = terminal.ws;
      void terminal.handleChangedHostKey(socket, {
        type: 'host_key_changed',
        fingerprint: newFingerprint,
        expectedFingerprint: oldFingerprint,
        keyType: 'ssh-ed25519',
        host: routeIdentity,
        displayHost: 'vps.example.com',
        port: 22,
      });
      socket.close(1000, 'Host key changed');
    });
  }, { oldFingerprint, newFingerprint, routeIdentity });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(oldFingerprint);
  await expect(dialog).toContainText(newFingerprint);
  await dialog.locator('.app-dialog__button--cancel').click();
  expect(knownHostUpdates).toEqual([]);
  expect(connectRequests).toBe(1);

  await page.evaluate(({ oldFingerprint, newFingerprint, routeIdentity }) => {
    void (window as any).eval("import('/src/main.ts')").then((module: any) => {
      const terminal = module.getTabManager().getActiveTab().terminal as any;
      void terminal.handleChangedHostKey(terminal.ws, {
        type: 'host_key_changed',
        fingerprint: newFingerprint,
        expectedFingerprint: oldFingerprint,
        keyType: 'ssh-ed25519',
        host: routeIdentity,
        displayHost: 'vps.example.com',
        port: 22,
      });
    });
  }, { oldFingerprint, newFingerprint, routeIdentity });

  await expect(dialog).toBeVisible();
  await dialog.locator('.app-dialog__button--confirm').click();
  await expect.poll(() => knownHostUpdates).toEqual([{
    host: routeIdentity,
    port: 22,
    fingerprint: newFingerprint,
  }]);
  await expect.poll(() => connectRequests).toBe(2);
  await expect(page.locator('#term-status')).toContainText('已连接');
});

test('认证成功但 Shell 未就绪时不显示在线且拒绝终端输入', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'connection-state-test-root';
    root.style.cssText = 'position:fixed;inset:0;width:390px;height:320px;';
    document.body.appendChild(root);
    const terminal = new terminalModule.SSHTerminal(root.id) as any;
    terminal.mount();
    terminal.ws = {
      readyState: WebSocket.OPEN,
      send: () => undefined,
      close: () => undefined,
    };
    terminal.trzszFilter = { processTerminalInput: () => undefined };
    terminal.sessionReady = false;
    const beforeShell = terminal.sendInput('whoami\r');
    terminal.sessionReady = true;
    const afterShell = terminal.sendInput('whoami\r');
    terminal.dispose();
    root.remove();
    return { beforeShell, afterShell };
  });

  expect(result).toEqual({ beforeShell: false, afterShell: true });
});
