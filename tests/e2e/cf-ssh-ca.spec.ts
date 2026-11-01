import { expect, test } from './fixtures';
import { blockOptionalThirdPartyAssets } from './helpers';

test('匿名连接表单：支持切换到 Cloudflare CA 模式并自动预填 Team 标识与身份标记', async ({ page }) => {
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
        authMode: 'github',
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
