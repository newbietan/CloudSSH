import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { blockOptionalThirdPartyAssets } from './helpers';

test('非 Access 登录不展示 Cloudflare CA 入口', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: false,
        sitekey: '',
        githubAuthEnabled: true,
        githubAuthRequired: false,
        sshSharingEnabled: false,
        authMode: 'anonymous',
        cfAccessEmail: 'alice@company.com',
        cfAccessTeamName: 'my-org',
      }),
    })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' })
  );

  await page.goto('/?lang=zh-CN');

  await expect(page.locator('#auth-tab-cf-ca')).toBeHidden();
  await expect(page.locator('#auth-cf-ca-section')).toBeHidden();
});

test('Access 登录下连接表单可切换到 Cloudflare CA 并预填团队标识', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: false,
        sitekey: '',
        githubAuthEnabled: true,
        githubAuthRequired: false,
        sshSharingEnabled: false,
        authMode: 'cf_access',
        cfAccessEmail: 'alice@company.com',
        cfAccessTeamName: 'my-org',
      }),
    })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' })
  );

  await page.goto('/?lang=zh-CN');

  // 点击 Cloudflare CA 选项卡
  await page.click('#auth-tab-cf-ca');
  await expect(page.locator('#auth-cf-ca-section')).toBeVisible();
  await expect(page.locator('#auth-password-section')).toBeHidden();
  await expect(page.locator('#auth-key-section')).toBeHidden();

  // 验证预填的 Team Name 与检测到的 Access 邮箱 badge
  const teamInput = page.locator('#cf-ca-team');
  await expect(teamInput).toHaveValue('my-org');

  const badge = page.locator('#cf-ca-access-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('alice@company.com');

  // 未填写主机与用户时点击连接：必须阻止提交，不得调用证书签发接口
  let signCalled = false;
  await page.route('**/api/cf-ssh-ca/sign', () => {
    signCalled = true;
  });
  await page.click('#connect-btn');
  expect(signCalled).toBe(false);
});

test('服务器列表：支持配置与保存 Cloudflare SSH CA 认证模式并展示 CF CA 徽章', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: false,
        sitekey: '',
        githubAuthEnabled: true,
        githubAuthRequired: false,
        sshSharingEnabled: false,
        authMode: 'cf_access',
      }),
    })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'alice', avatar_url: '' }),
    })
  );

  const mockServer = {
    id: 1,
    user_id: 1,
    name: 'Production Node',
    host: 'node1.example.com',
    port: 22,
    username: 'root',
    auth_method: 'publickey',
    cf_ssh_ca_team: 'my-org',
    tags: ['prod'],
    region: null,
    inferred_hint: null,
    created_at: '',
    updated_at: '',
  };

  await page.route('**/api/servers', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([mockServer]),
      });
    }
    return route.continue();
  });

  await page.goto('/?lang=zh-CN');

  // 进入服务器列表（用户空间）
  await expect(page.locator('#user-space-section')).toBeVisible();

  // 验证卡片上的 CF CA 徽标
  const card = page.locator('#card-1');
  await expect(card).toBeVisible();
  await expect(card).toContainText('CF CA');

  // 点击编辑服务器
  await card.locator('#edit-1').click();
  await expect(page.locator('#server-modal')).toBeVisible();

  // 验证模态框内激活了 Cloudflare CA tab 并回显了 Team Name
  await expect(page.locator('#modal-auth-tab-cf-ca')).toHaveClass(/auth-tab-active/);
  await expect(page.locator('#modal-cf-ca-section')).toBeVisible();
  await expect(page.locator('#server-cf-ca-team')).toHaveValue('my-org');
});

async function openCaForm(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/config', route => route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: false, githubAuthRequired: false,
    authMode: 'cf_access', cfAccessTeamName: 'my-org',
  } }));
  await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/known-hosts?**', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
  });
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#auth-tab-cf-ca')).toBeVisible();
  await page.locator('#host').fill('ssh.example.com');
  await page.locator('#username').fill('developer');
  await page.locator('#auth-tab-cf-ca').click();
}

for (const changed of ['host', 'username', 'port', 'team', 'mode'] as const) {
  test(`CA 签发期间禁止重复提交，${changed} 改变后丢弃迟到证书`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let signRequests = 0;
    let sockets = 0;
    await page.route('**/api/cf-ssh-ca/sign', async route => {
      expect(route.request().method()).toBe('POST');
      signRequests++;
      await gate;
      await route.fulfill({ json: { certificate: 'late-certificate' } });
    });
    await page.routeWebSocket('**/api/ssh*', socket => { sockets++; socket.close(); });
    await openCaForm(page);
    await page.locator('#connect-btn').click();
    await expect.poll(() => signRequests).toBe(1);
    await expect(page.locator('#connect-btn')).toBeDisabled();
    await page.locator('#connection-form').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    if (changed === 'mode') {
      await page.locator('#auth-tab-password').click();
      await page.locator('#auth-tab-cf-ca').click();
    } else {
      const target = changed === 'team' ? '#cf-ca-team' : `#${changed}`;
      await page.locator(target).fill(changed === 'port' ? '2222' : 'changed-value');
    }
    const response = page.waitForResponse('**/api/cf-ssh-ca/sign');
    release();
    await response;
    await expect(page.locator('#connect-btn')).toBeEnabled();
    await expect(page.locator('#auth-section')).toBeVisible();
    expect(signRequests).toBe(1);
    expect(sockets).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('cloudssh_recent_connections'))).toBeNull();
  });
}

test('CA 正常签发只开一个连接且临时私钥不写入历史', async ({ page }) => {
  const configs: Array<Record<string, unknown>> = [];
  let signRequests = 0;
  await page.route('**/api/cf-ssh-ca/sign', route => {
    expect(route.request().method()).toBe('POST');
    signRequests++;
    return route.fulfill({ json: { certificate: 'short-lived-certificate' } });
  });
  await page.routeWebSocket('**/api/ssh*', socket => {
    socket.onMessage(data => {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.host) {
        configs.push(message);
        socket.send(JSON.stringify({ type: 'status', event: 'auth_success', message: '' }));
        socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: '' }));
      }
    });
  });
  await openCaForm(page);
  await page.locator('#remember-me').check();
  await page.locator('#connect-btn').click();
  await expect.poll(() => configs.length).toBe(1);
  expect(signRequests).toBe(1);
  expect(configs[0]).toMatchObject({ authMethod: 'publickey', certificate: 'short-lived-certificate' });
  const history = await page.evaluate(() => localStorage.getItem('cloudssh_recent_connections'));
  expect(history).not.toContain('PRIVATE KEY');
  expect(history).not.toContain('encryptedCred');
  expect(history).not.toContain('short-lived-certificate');
});
