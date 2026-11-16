import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const server = { id: 1, user_id: 1, name: 'Personal test server', host: 'ssh.example.com', port: 22,
  username: 'deploy', auth_method: 'password', tags: [], os: null, region: null, created_at: '', updated_at: '' };
const token = { id: '12345678-1234-1234-1234-123456789abc', name: 'Claude Code', serverIds: [1],
  scopes: ['read'], expiresAt: Date.now() + 86400_000, createdAt: Date.now() };
const session = 'session:1780000000000:12345678-1234-1234-1234-123456789abc';

async function setup(page: Page) {
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [server] }) : route.fallback());
  await page.route('**/api/mcp/activity', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [{ id: 'op', client: 'Cursor', serverId: 1, tool: 'sftp_read', status: 'success', startedAt: Date.now(), finishedAt: Date.now() }] }) : route.fallback());
}
async function openPanel(page: Page) {
  const more = page.locator('#user-space-more-btn');
  if (await more.isVisible()) await more.click();
  await page.locator('#user-space-header-actions [data-mcp-open]').click();
  await expect(page.locator('#mcp-token-form')).toBeVisible();
}

test('creates least-privilege tokens, displays one-time config, revokes and clears secrets on close', async ({ page }) => {
  await setup(page);
  let rows: unknown[] = [];
  const created: unknown[] = [];
  let revoked = false;
  await page.route('**/api/mcp/tokens', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: rows });
    if (route.request().method() !== 'POST') return route.fallback();
    created.push(route.request().postDataJSON()); rows = [token];
    return route.fulfill({ json: { ...token, token: `mcp_42:${'a'.repeat(64)}` } });
  });
  await page.route(`**/api/mcp/tokens/${token.id}`, route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    revoked = true; rows = []; return route.fulfill({ json: { success: true } });
  });
  await page.goto('/?lang=en-US');
  await openPanel(page);
  const dialog = page.locator('#mcp-dialog');
  await dialog.locator('input[name="name"]').fill('Claude Code');
  await dialog.getByLabel(server.name, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Generate token', exact: true }).click();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toEqual({ name: 'Claude Code', serverIds: [1], scopes: ['read'], days: 30 });
  await expect(page.locator('#mcp-client-config')).toHaveValue(/Bearer mcp_42:/);
  await expect(page.locator('#mcp-activity-list')).toContainText('Cursor');
  const violations = (await new AxeBuilder({ page }).include('#mcp-dialog').analyze()).violations;
  expect(violations).toEqual([]);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeLessThanOrEqual(viewport.width);
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  expect(revoked).toBe(false);
  await dialog.getByRole('button', { name: 'Confirm revocation', exact: true }).click();
  await expect.poll(() => revoked).toBe(true);
  await expect(page.locator('#mcp-client-config')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('mcp_42:');
});

test('explicitly shares only a connected saved tab and rechecks authoritative state on reopen', async ({ page }) => {
  await setup(page);
  await page.route('**/api/mcp/tokens', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback());
  await page.route('**/api/servers/1/memory', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { workLogs: [], knowledge: [] } }) : route.fallback());
  const updates: Record<string, unknown>[] = [];
  let expiresAt = 0;
  await page.route('**/api/mcp/context', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON(); updates.push(body);
    if (typeof body.enabled === 'boolean') expiresAt = body.enabled ? Date.now() + 1800_000 : 0;
    return route.fulfill({ json: { expiresAt } });
  });
  await page.routeWebSocket('**/api/ssh*', socket => {
    socket.send(JSON.stringify({ type: 'session_created', sessionId: session, resumeToken: 'not-a-context-token' }));
    socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: 'ready' }));
    socket.onMessage(data => {
      if (typeof data !== 'string') return;
      try { const msg = JSON.parse(data); if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', id: msg.id })); } catch { /* shell input */ }
    });
  });
  await page.goto('/?lang=en-US');
  await expect(page.locator('#user-space-section')).toBeVisible();
  await page.evaluate(async () => {
    const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
    const tab = getTabManager().createTab('Shared tab', { host: 'ssh.example.com', port: 22, serverId: 1 });
    tab.terminal.connectWithWebSocket(new WebSocket(`ws://${location.host}/api/ssh?token=e2e`), tab.hostInfo);
  });
  await openPanel(page);
  const dialog = page.locator('#mcp-dialog');
  await expect(dialog.getByRole('button', { name: 'Share recent output', exact: true })).toBeEnabled();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ session, serverId: 1, inspect: true });
  await dialog.getByRole('button', { name: 'Share recent output', exact: true }).click();
  await expect(dialog.getByLabel('Context arguments for your assistant')).toHaveValue(new RegExp(session));
  expect(updates[1]).toMatchObject({ session, serverId: 1, enabled: true });
  expect(JSON.stringify(updates)).not.toContain('not-a-context-token');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await openPanel(page);
  await dialog.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await expect(dialog.getByLabel('Context arguments for your assistant')).toBeHidden();
  expect(updates.at(-1)).toMatchObject({ enabled: false });
});

for (const [locale, title] of [['zh-CN', '外部助手'], ['zh-TW', '外部助理'], ['en-US', 'External assistants']]) {
  test(`localized panel, theme adaptation and responsive inputs (${locale})`, async ({ page }) => {
    await setup(page);
    await page.route('**/api/mcp/tokens', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback());
    await page.goto(`/?lang=${locale}`);
    await openPanel(page);
    await expect(page.locator('#mcp-title')).toHaveText(title);
    expect(await page.locator('#mcp-token-form input[name="name"]').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await page.keyboard.press('Escape');
    await expect(page.locator('#mcp-dialog')).toHaveCount(0);
  });
}

test('anonymous page never exposes external assistant entry points', async ({ page }) => {
  await page.goto('/?lang=en-US');
  for (const button of await page.locator('[data-mcp-open]').all()) await expect(button).toBeHidden();
});
