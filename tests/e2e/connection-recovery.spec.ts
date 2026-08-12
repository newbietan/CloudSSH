import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
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
