import type { WebSocketRoute } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockAnonymousSession } from './helpers';

test.beforeEach(async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/known-hosts?**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
  });
});

test('匿名 none 连接不发送残留凭据，重连及历史恢复保持认证方式', async ({ page }) => {
  const configs: Array<Record<string, unknown>> = [];
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket('**/api/ssh*', (socket) => {
    sockets.push(socket);
    socket.onMessage((data) => {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.host) {
        configs.push(message);
        socket.send(JSON.stringify({ type: 'status', event: 'auth_success', message: '' }));
        socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: '' }));
      } else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', id: message.id }));
      }
    });
  });
  await page.goto('/?lang=zh-CN');
  await page.locator('#host').fill('ssh.example.com');
  await page.locator('#username').fill('token-user');
  // 私钥模式仍然必填；切到 none 后隐藏两类凭据。
  await page.locator('#auth-tab-key').click();
  await page.locator('#connect-btn').click();
  await expect(page.locator('.app-toast')).toContainText('请输入私钥');
  expect(configs).toHaveLength(0);
  await page.locator('#auth-tab-password').click();
  await page.locator('#password').fill('must-not-send-password');
  await page.locator('#auth-tab-key').click();
  await page.locator('#private-key').fill('must-not-send-key');
  await page.locator('#auth-tab-none').click();
  await expect(page.locator('#auth-none-section')).toBeVisible();
  await expect(page.locator('#auth-none-section')).toContainText(
    '仅适用于允许 SSH none 认证的服务器，不发送密码或私钥。'
  );
  await expect(page.locator('#password')).toBeHidden();
  await expect(page.locator('#private-key')).toBeHidden();
  await page.locator('#connect-btn').click();
  await expect.poll(() => configs.length).toBe(1);
  expect(configs[0]).toMatchObject({ host: 'ssh.example.com', username: 'token-user', authMethod: 'none' });
  expect(configs[0]).not.toHaveProperty('password');
  expect(configs[0]).not.toHaveProperty('privateKey');

  sockets[0].close({ code: 1011, reason: 'test network interruption' });
  await expect.poll(() => configs.length, { timeout: 10_000 }).toBe(2);
  expect(configs[1]).toEqual(configs[0]);

  await page.reload();
  await expect(page.locator('#auth-tab-none')).toHaveClass(/auth-tab-active/);
  await expect(page.locator('#username')).toHaveValue('token-user');
  await expect(page.locator('#auth-none-section')).toBeVisible();
  await expect(page.locator('#recent-connections-list')).toContainText('NONE');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cloudssh_recent_connections')!)[0].authMethod)).toBe('none');
});

test('none 被拒绝后不弹交互认证，也不自动重连', async ({ page }) => {
  let connections = 0;
  await page.routeWebSocket('**/api/ssh*', (socket) => {
    connections++;
    socket.onMessage((data) => {
      if (typeof data !== 'string' || !JSON.parse(data).host) return;
      socket.send(JSON.stringify({ type: 'error', event: 'auth_none_rejected', message: 'none rejected' }));
      // Even an abnormal transport close must not retry a rejected none login.
      socket.close({ code: 1011 });
    });
  });
  await page.goto('/?lang=zh-CN');
  await page.locator('#host').fill('ssh.example.com');
  await page.locator('#username').fill('token-user');
  await page.locator('#auth-tab-none').click();
  await page.locator('#connect-btn').click();
  await expect.poll(() => connections).toBe(1);
  await page.waitForTimeout(1600); // 超过首次自动重连的 1s 延时。
  expect(connections).toBe(1);
  await expect(page.locator('.auth-challenge-dialog')).toHaveCount(0);
});

for (const event of ['algorithm_error', 'host_key_invalid']) {
  test(`${event} 终止握手后即使异常关闭也不自动重连`, async ({ page }) => {
    let connections = 0;
    await page.routeWebSocket('**/api/ssh*', (socket) => {
      connections++;
      socket.onMessage((data) => {
        if (typeof data !== 'string' || !JSON.parse(data).host) return;
        socket.send(JSON.stringify({ type: 'error', event, message: 'handshake rejected',
          params: { message: 'No common host key algorithm' } }));
        socket.close({ code: 1011 });
      });
    });
    await page.goto('/?lang=en-US');
    await page.locator('#host').fill('ssh.example.com');
    await page.locator('#username').fill('token-user');
    await page.locator('#auth-tab-none').click();
    await page.locator('#connect-btn').click();
    await expect.poll(() => connections).toBe(1);
    await page.waitForTimeout(1600);
    expect(connections).toBe(1);
    await expect(page.locator('.auth-challenge-dialog')).toHaveCount(0);
  });
}
