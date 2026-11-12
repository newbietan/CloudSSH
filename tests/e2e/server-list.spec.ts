import { expect, test } from './fixtures';
import { blockOptionalThirdPartyAssets } from './helpers';

const servers = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1,
  user_id: 1,
  name: `Server ${String(index + 1).padStart(2, '0')}`,
  host: index === 0 ? '203.0.113.42' : `host-${index + 1}.example.com`,
  port: 22,
  username: 'deploy',
  auth_method: 'publickey',
  region: null,
  inferred_hint: 'apac',
  os: index === 0 ? 'ubuntu' : null,
  tags: index === 2 ? [] : index % 2 === 0 ? ['production', 'apac'] : ['staging'],
  created_at: '',
  updated_at: '',
}));

test.beforeEach(async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servers) })
  );
});

test('none 与空密码可保存，编辑留空保留旧密码，显式勾选才能清空', async ({ page }) => {
  let rows = [servers[0]];
  const added: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  await page.route('**/api/servers', (route) => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: rows });
    if (method !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    added.push(body);
    const server = { ...servers[0], ...body, id: rows.length + 1 };
    rows.push(server);
    return route.fulfill({ status: 201, json: server });
  });
  await page.route('**/api/servers/1', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON();
    updated.push(body);
    rows = rows.map((server) => server.id === 1 ? { ...server, auth_method: body.auth_method } : server);
    return route.fulfill({ json: rows[0] });
  });
  await page.goto('/?lang=zh-CN');
  await page.locator('#add-server-btn').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#modal-auth-tab-password')).toHaveClass(/auth-tab-active/);
  await page.locator('#server-name').fill('Username only');
  await page.locator('#server-host').fill('ssh.example.com');
  await page.locator('#server-username').fill('token-user');
  await page.locator('#server-password').fill('must-not-save');
  await page.locator('#modal-auth-tab-none').click();
  await expect(page.locator('#server-password')).toBeHidden();
  await expect(page.locator('#server-private-key')).toBeHidden();
  await expect(page.locator('#modal-none-section')).toBeVisible();
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => added.length).toBe(1);
  expect(added[0].auth_method).toBe('none');
  expect(added[0]).not.toHaveProperty('credential');
  await expect(page.locator('#card-2')).toContainText('NONE');

  await page.locator('#clone-2').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#modal-auth-tab-none')).toHaveClass(/auth-tab-active/);
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => added.length).toBe(2);
  expect(added[1].auth_method).toBe('none');
  expect(added[1]).not.toHaveProperty('credential');

  await page.locator('#edit-1').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#modal-auth-tab-key')).toHaveClass(/auth-tab-active/);
  await page.locator('#modal-auth-tab-none').click();
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => updated.length).toBe(1);
  expect(updated[0].auth_method).toBe('none');
  expect(updated[0]).not.toHaveProperty('credential');
  await expect(page.locator('#server-modal')).toBeHidden();

  await page.locator('#edit-1').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#modal-auth-tab-none')).toHaveClass(/auth-tab-active/);
  await page.locator('#modal-auth-tab-password').click();
  await expect(page.locator('#server-empty-password-option')).toBeHidden();
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => updated.length).toBe(2);
  expect(updated[1]).toMatchObject({ auth_method: 'password', credential: '' });
  await expect(page.locator('#server-modal')).toBeHidden();

  await page.locator('#edit-1').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#server-empty-password-option')).toBeVisible();
  await expect(page.locator('#server-password-hint')).toContainText('留空保留');
  await page.locator('#server-password').fill('fresh-secret');
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => updated.length).toBe(3);
  expect(updated[2]).toMatchObject({ auth_method: 'password', credential: 'fresh-secret' });
  await expect(page.locator('#server-modal')).toBeHidden();

  await page.locator('#edit-1').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#server-password')).toHaveValue('');
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => updated.length).toBe(4);
  expect(updated[3].auth_method).toBe('password');
  expect(updated[3]).not.toHaveProperty('credential');
  await expect(page.locator('#server-modal')).toBeHidden();

  await page.locator('#edit-1').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await page.locator('#server-empty-password').check();
  await expect(page.locator('#server-password')).toBeDisabled();
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => updated.length).toBe(5);
  expect(updated[4]).toMatchObject({ auth_method: 'password', credential: '' });
  await expect(page.locator('#server-modal')).toBeHidden();

  await page.locator('#edit-1').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#server-empty-password')).not.toBeChecked();
  await expect(page.locator('#server-password')).toBeEnabled();
  await page.locator('#modal-auth-tab-key').click();
  await page.locator('#server-submit-btn').click();
  await expect(page.locator('.app-toast').filter({ hasText: '切换认证方式后' })).toBeVisible();
  expect(updated).toHaveLength(5);
  await page.locator('#modal-close-btn').click();

  await page.locator('#add-server-btn').click();
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#server-password')).toBeEnabled();
  await expect(page.locator('#server-empty-password-option')).toBeHidden();
  await page.locator('#server-name').fill('Empty password');
  await page.locator('#server-host').fill('ssh.example.com');
  await page.locator('#server-username').fill('alice');
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => added.length).toBe(3);
  expect(added[2]).toMatchObject({ auth_method: 'password', credential: '' });
});

test('paginates after filtering and resets to the first page', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.server-card')).toHaveCount(6);
  await expect(page.locator('#server-page-info')).toContainText('30');

  await page.locator('#server-page-next').click();
  await expect(page.locator('.server-card')).toHaveCount(6);
  await expect(page.locator('#server-page-info')).toContainText('2');

  await page.locator('#server-tag-filter').selectOption('production');
  await expect(page.locator('.server-card')).toHaveCount(6);
  await expect(page.locator('#server-pagination')).toBeVisible();

  await page.locator('#server-search').fill('Server 01');
  await expect(page.locator('.server-card')).toHaveCount(1);
  await expect(page.locator('.server-card')).toContainText('#production');
});

test('有无标签的同排服务器卡片将操作按钮对齐到底部', async ({ page }) => {
  await page.goto('/');

  const visibleCards = page.locator('.server-card').filter({ visible: true });
  await expect(visibleCards).toHaveCount(6);

  const positions = await page
    .locator('.server-card:nth-child(-n+3) .server-card-actions')
    .evaluateAll(async (elements) => {
      // Visibility does not imply that staggered transform animations have settled.
      await document.fonts.ready;
      await Promise.all(elements.flatMap((element) =>
        element.closest('.server-card')!.getAnimations().map((animation) =>
          animation.finished.catch(() => {})
        )
      ));
      return elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        };
      });
    });

  expect(new Set(positions.map(({ top }) => top)).size).toBe(1);
  expect(new Set(positions.map(({ bottom }) => bottom)).size).toBe(1);
});

test('IP 掩码按钮支持键盘复制完整地址', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copiedServerIP = text;
        },
      },
    });
  });
  await page.goto('/?lang=zh-CN');

  const badge = page.locator('#host-badge-1');
  await expect(badge).toHaveJSProperty('tagName', 'BUTTON');
  await expect(badge).toHaveText('203.0.*.*:22');
  await badge.focus();
  await page.keyboard.press('Enter');

  await expect
    .poll(() => page.evaluate(() => (window as any).__copiedServerIP))
    .toBe('203.0.113.42');
  await expect(page.locator('.app-toast')).toContainText('已复制服务器 IP');
});

test('已识别服务器显示系统图标，未识别服务器保留默认图标', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  const firstCard = page.locator('.server-card').nth(0);
  await expect(firstCard.locator('.server-os-icon')).toHaveAttribute('title', 'Ubuntu');
  await expect(firstCard.locator('.server-os-icon svg')).toHaveAttribute('aria-label', 'Ubuntu');

  const secondCard = page.locator('.server-card').nth(1);
  await expect(secondCard.locator('.server-os-icon')).toHaveCount(0);
  await expect(secondCard.locator('.material-symbols-outlined').first()).toHaveText('dns');
});

test('展示多级跳转路径并在编辑时排除自身跳板', async ({ page }) => {
  await page.unroute('**/api/servers');
  const jumpServers = servers.map((server) => ({
    ...server,
    jump_server_id: server.id === 2 ? 1 : server.id === 3 ? 2 : null,
  }));
  await page.route('**/api/servers', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(jumpServers),
    })
  );
  await page.goto('/?lang=zh-CN');

  await expect(page.locator('#card-3')).toContainText('Server 01 → Server 02');
  await expect(page.locator('#card-3')).toContainText('由跳板入口决定');
  await expect(page.locator('#card-3')).toContainText('随跳板');
  await page.locator('#edit-3').click();
  const jumpSelect = page.locator('#server-jump-host');
  const regionSelect = page.locator('#server-region');
  await expect(jumpSelect).toHaveValue('2');
  await expect(jumpSelect.locator('option[value="3"]')).toHaveCount(0);
  await expect(jumpSelect.locator('option[value="2"]')).toHaveText('Server 02');
  await expect(regionSelect).toBeDisabled();
  await expect(page.locator('#server-region-inferred')).toContainText('不会查询当前内网主机');

  await jumpSelect.selectOption('');
  await expect(regionSelect).toBeEnabled();
  await expect(regionSelect).toHaveValue('');
});

test('点击克隆服务器按钮打开预填表单并附带复制后缀', async ({ page }) => {
  await page.goto('/?lang=zh-CN');

  const cloneBtn = page.locator('#clone-1');
  await expect(cloneBtn).toBeVisible();
  await cloneBtn.click();

  const modal = page.locator('#server-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#modal-title')).toContainText('克隆服务器');
  await expect(page.locator('#server-name')).toHaveValue('Server 01 (复制)');
  await expect(page.locator('#server-host')).toHaveValue('203.0.113.42');
  await expect(page.locator('#server-port')).toHaveValue('22');
  await expect(page.locator('#server-username')).toHaveValue('deploy');
});

test('CF 隧道模式：表单隐藏端口字段、卡片仅展示域名、保存回落端口 22', async ({ page }) => {
  const tunnelServers = [
    {
      id: 101,
      user_id: 1,
      name: 'Home Lab',
      host: 'ssh.example.com',
      port: 22,
      username: 'root',
      auth_method: 'password',
      region: null,
      inferred_hint: null,
      os: null,
      tags: [],
      transport_type: 'cf_tunnel',
      cf_tunnel_host: 'ssh.example.com',
      cf_access_client_id: null,
      has_cf_access_client_secret: false,
      jump_server_id: null,
      created_at: '',
      updated_at: '',
    },
    {
      id: 102,
      user_id: 1,
      name: 'Direct Box',
      host: '203.0.113.7',
      port: 2222,
      username: 'deploy',
      auth_method: 'password',
      region: null,
      inferred_hint: null,
      os: null,
      tags: [],
      transport_type: 'direct',
      cf_tunnel_host: null,
      cf_access_client_id: null,
      has_cf_access_client_secret: false,
      jump_server_id: null,
      created_at: '',
      updated_at: '',
    },
  ];

  // 后注册的 route 优先命中，覆盖 beforeEach 的默认服务器列表
  const submittedBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/servers', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      submittedBodies.push(body);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...body, id: 103 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tunnelServers),
    });
  });

  await page.goto('/?lang=zh-CN');

  // 卡片：隧道连接只看域名（保留默认 22 存储值也不展示），直连仍显示 host:port（IP 为隐私掩码形态）
  await expect(page.locator('#host-badge-101')).toHaveText('ssh.example.com');
  await expect(page.locator('#host-badge-102')).toHaveText('203.0.*.*:2222');

  // 新建：默认直连显示端口字段；切到隧道后隐藏，切回直连恢复
  await page.locator('#add-server-btn').click();
  // Wait for the modal's deferred initial focus before sequential fills can race it.
  await expect(page.locator('#server-name')).toBeFocused();
  await expect(page.locator('#server-port-field')).toBeVisible();
  await page.locator('#modal-transport-tab-tunnel').click();
  await expect(page.locator('#server-port-field')).toBeHidden();
  await page.locator('#modal-transport-tab-direct').click();
  await expect(page.locator('#server-port-field')).toBeVisible();

  // 先在直连态清空端口，再切隧道提交：保存时应回落 22（仅作存储记录，不参与连接寻址）
  await page.locator('#server-port').fill('');
  await page.locator('#modal-transport-tab-tunnel').click();
  await page.locator('#server-name').fill('Tunnel Save');
  await page.locator('#server-host').fill('ssh.homelab.example.com');
  await page.locator('#server-username').fill('root');
  await page.locator('#server-password').fill('secret');
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => submittedBodies[0]?.port).toBe(22);
  expect(submittedBodies[0]?.transport_type).toBe('cf_tunnel');
  expect(submittedBodies[0]?.cf_tunnel_host).toBe('ssh.homelab.example.com');

  // 编辑既有隧道服务器：端口字段同样隐藏
  await page.locator('#edit-101').click();
  await expect(page.locator('#server-modal')).toBeVisible();
  await expect(page.locator('#server-port-field')).toBeHidden();
});
