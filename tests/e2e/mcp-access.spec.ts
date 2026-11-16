import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
const server = { id: 1, user_id: 1, name: 'Access test server', host: 'ssh.example.com', port: 22,
  username: 'deploy', auth_method: 'password', tags: [], os: null, created_at: '', updated_at: '' };
const token = 'SAVED-ACCOUNT-TOKEN'; const clientId = 'SERVICE-ID.access'; const secret = 'SERVICE-SECRET';
async function setup(page: Page, mode: 'cf_access' | 'password' = 'cf_access') {
  await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: false, githubAuthRequired: true, authMode: mode, cfAccessEmail: mode === 'cf_access' ? 'owner@example.com' : null,
  } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    id: 1, github_id: mode === 'cf_access' ? -2 : -1, username: 'owner@example.com', avatar_url: null,
  } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET' ? route.fulfill({ json: [server] }) : route.fallback());
  const state = { info: { configured: false, id: null as string | null, grants: [] as any[], hasAccessCredentials: false, legacy: false },
    access: null as null | { clientId: string; clientSecret: string }, writes: [] as any[], exports: 0 };
  await page.route('**/api/mcp/config', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state.info });
    if (!['POST', 'PUT'].includes(route.request().method())) return route.fallback();
    const body = route.request().postDataJSON(); state.writes.push(body);
    if (body.access) state.access = body.access;
    state.info = { configured: true, id: 'singleton', grants: body.grants, hasAccessCredentials: !!state.access, legacy: false };
    return route.fulfill({ json: state.info });
  });
  await page.route('**/api/mcp/config/credentials', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.exports++; return route.fulfill({ json: { token, ...(state.access ? { access: state.access } : {}) } });
  });
  await page.route('**/api/mcp/activity', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback());
  return state;
}
async function open(page: Page) {
  if (await page.locator('#user-space-more-btn').isVisible()) await page.locator('#user-space-more-btn').click();
  await page.locator('#user-space-header-actions [data-mcp-open]').click();
  await expect(page.locator('#mcp-config-form')).toBeVisible();
}
async function fillAccess(page: Page) {
  await page.locator('#mcp-access-client-id').fill(clientId); await page.locator('#mcp-access-client-secret').fill(secret);
  await page.locator('#mcp-access-policy-confirmed').check();
}

test('Access credentials are explicitly saved with the unique account configuration and can be exported again after reopening', async ({ page }) => {
  const state = await setup(page); await page.goto('/?lang=en-US'); await open(page);
  await expect(page.locator('#mcp-access-guide')).toHaveAttribute('open', '');
  await page.locator('input[data-server-id="1"][value="read"]').check();
  await page.locator('#mcp-save-config').click(); expect(state.writes).toHaveLength(0);
  await page.locator('#mcp-access-client-id').fill(clientId); await page.locator('#mcp-access-client-secret').fill(secret);
  await page.locator('#mcp-save-config').click(); expect(state.writes).toHaveLength(0);
  await page.locator('#mcp-access-policy-confirmed').check(); await page.locator('#mcp-save-config').click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toEqual({ grants: [{ serverId: 1, scopes: ['read'] }], access: { clientId, clientSecret: secret } });
  await expect(page.locator('#mcp-access-client-secret')).toHaveValue('');
  await expect(page.locator('#mcp-access-guide')).not.toHaveAttribute('open', ''); expect(state.exports).toBe(0);
  await page.locator('#mcp-view-config').click();
  const config = JSON.parse(await page.locator('#mcp-client-config').inputValue());
  expect(config.mcpServers.cloudssh.headers).toEqual({ Authorization: `Bearer ${token}`, 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': secret });
  await page.locator('#mcp-dialog').getByRole('button', { name: 'Close', exact: true }).click(); await open(page);
  await expect(page.locator('#mcp-client-config')).toHaveCount(0);
  await expect(page.locator('#mcp-access-guide')).not.toHaveAttribute('open', '');
  await page.locator('#mcp-view-config').click(); await expect(page.locator('#mcp-client-config')).toHaveValue(new RegExp(secret));
  await page.locator('input[data-server-id="1"][value="context"]').check(); await page.locator('#mcp-save-config').click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual({ grants: [{ serverId: 1, scopes: ['read', 'context'] }] });
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toMatch(/SERVICE-SECRET|SAVED-ACCOUNT-TOKEN/);
});

for (const [locale, caption] of [['zh-CN', 'Cloudflare Access 连接'], ['zh-TW', 'Cloudflare Access 連線'], ['en-US', 'Cloudflare Access connection']]) {
  test(`compact Access guide and theme controls (${locale})`, async ({ page }) => {
    await setup(page); await page.goto(`/?lang=${locale}`); await open(page);
    await expect(page.locator('#mcp-access-guide > summary')).toHaveText(caption);
    await expect(page.locator('#mcp-access-guide')).toContainText('Service Auth');
    for (const link of await page.locator('#mcp-access-guide a').all()) await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await page.locator('#mcp-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
    expect(await page.locator('#mcp-access-client-secret').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    expect((await new AxeBuilder({ page }).include('#mcp-dialog').analyze()).violations).toEqual([]);
  });
}

test('all four themes apply modal radius, shadow and glass material while actions stay reachable', async ({ page }) => {
  await setup(page); await page.goto('/?lang=en-US'); await open(page);
  const colors = new Set<string>();
  for (const theme of ['standard-dark', 'standard-light', 'cyberpunk', 'liquid-glass']) {
    await page.evaluate(async name => { const { applyBuiltInTheme } = await (window as any).eval("import('/src/theme.ts')"); applyBuiltInTheme(name); }, theme);
    const style = await page.locator('.mcp-dialog__panel').evaluate(node => {
      const css = getComputedStyle(node); return { color: css.color, background: css.backgroundColor,
        radius: parseFloat(css.borderTopLeftRadius), shadow: css.boxShadow, filter: css.backdropFilter };
    });
    colors.add(style.background);
    if (theme === 'liquid-glass') { expect(style.filter).toContain('blur'); expect(style.radius).toBeGreaterThan(0); expect(style.background).toContain('0.96'); }
    await expect(page.locator('#mcp-save-config')).toBeVisible();
    expect(await page.locator('#mcp-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  }
  expect(colors.size).toBeGreaterThanOrEqual(3);
});

test('ordinary sign-in does not show or require Access credentials', async ({ page }) => {
  await setup(page, 'password'); await page.goto('/?lang=en-US'); await open(page);
  await expect(page.locator('#mcp-access-guide')).toHaveCount(0);
  await expect(page.locator('#mcp-config-form')).not.toContainText('Service Auth');
});

test('mode changes discard locally visible secrets and pending responses cannot restore them', async ({ page }) => {
  await setup(page); await page.goto('/?lang=en-US'); await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(async () => {
    const { McpManager } = await (window as any).eval("import('/src/mcp-manager.ts')");
    const manager = new McpManager(() => null); manager.setIdentity('owner', 'cf_access'); await manager.open();
    (document.getElementById('mcp-access-client-secret') as HTMLInputElement).value = 'LOCAL-ONLY-SECRET';
    manager.setIdentity('owner', 'password'); await manager.open(); (window as any).__manager = manager;
  });
  await expect(page.locator('#mcp-access-guide')).toHaveCount(0);
  await expect(page.locator('#mcp-dialog')).not.toContainText('LOCAL-ONLY-SECRET');
  await page.evaluate(() => (window as any).__manager.setIdentity(null)); await expect(page.locator('#mcp-dialog')).toHaveCount(0);
});
