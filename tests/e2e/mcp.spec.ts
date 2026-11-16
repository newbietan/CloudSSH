import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const servers = [1, 3].map(id => ({ id, user_id: 1, name: `Personal server ${id}`, host: 'ssh.example.com', port: 22,
  username: 'deploy', auth_method: 'password', tags: [], os: null, region: null, created_at: '', updated_at: '' }));
const id = '12345678-1234-1234-1234-123456789abc';
const token = 'SINGLETON-PERSONAL-TOKEN';
const session = `session:1780000000000:${id}`;
const empty = () => ({ configured: false, id: null as string | null, grants: [] as { serverId: number; scopes: string[] }[], hasAccessCredentials: false, legacy: false });

async function setup(page: Page) {
  await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github',
  } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET' ? route.fulfill({ json: servers }) : route.fallback());
  const state = { info: empty(), created: 0, writes: [] as any[], exports: 0, activityReads: 0 };
  await page.route('**/api/mcp/config', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: state.info });
    if (!['POST', 'PUT'].includes(method)) return route.fallback();
    const body = route.request().postDataJSON(); state.writes.push(body);
    if (method === 'POST' && !state.info.configured) state.created++;
    state.info = { ...state.info, configured: true, id, grants: body.grants, legacy: false };
    return route.fulfill({ json: state.info });
  });
  await page.route('**/api/mcp/config/credentials', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.exports++; return route.fulfill({ json: { token } });
  });
  await page.route('**/api/mcp/activity', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    state.activityReads++; return route.fulfill({ json: [{ id: 'op', client: 'MCP', serverId: 1, tool: 'sftp_read', status: 'success', startedAt: Date.now(), finishedAt: Date.now() }] });
  });
  await page.addInitScript(() => {
    (window as any).__mcpCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async (items: ClipboardItem[]) => { for (const item of items) (window as any).__mcpCopies.push(await (await item.getType('text/plain')).text()); },
      writeText: async (text: string) => { (window as any).__mcpCopies.push(text); },
    } });
  });
  return state;
}
async function openPanel(page: Page) {
  if (await page.locator('#user-space-more-btn').isVisible()) await page.locator('#user-space-more-btn').click();
  const opener = page.locator('#user-space-header-actions [data-mcp-open]');
  await expect(opener).toHaveAccessibleName(/.+/); await opener.click();
  await expect(page.locator('#mcp-config-form')).toBeVisible();
}

test('one permanent configuration: generate once, repeatedly copy, change separate server permissions, and reopen without rotation', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/?lang=en-US'); await openPanel(page);
  const dialog = page.locator('#mcp-dialog');
  await expect(page.locator('input[name="name"], input[name="days"], #mcp-token-list, #mcp-access-guide')).toHaveCount(0);
  await expect(dialog).not.toContainText('Revoke');
  await expect(page.locator('#mcp-copy-config')).toBeDisabled();
  await page.locator('input[data-server-id="1"][value="read"]').check();
  await page.locator('input[data-server-id="3"][value="exec"]').check();
  await page.locator('#mcp-save-config').click();
  await expect.poll(() => state.created).toBe(1);
  expect(state.writes[0]).toEqual({ grants: [{ serverId: 1, scopes: ['read'] }, { serverId: 3, scopes: ['exec'] }] });
  await expect(page.locator('#mcp-copy-config')).toBeEnabled(); expect(state.exports).toBe(0);
  await page.locator('#mcp-copy-config').click();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpCopies.length)).toBe(1);
  await page.locator('#mcp-copy-config').click();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpCopies.length)).toBe(2);
  const copies = await page.evaluate(() => (window as any).__mcpCopies);
  expect(copies[0]).toBe(copies[1]); expect(JSON.parse(copies[0]).mcpServers.cloudssh.headers.Authorization).toBe(`Bearer ${token}`);
  await page.locator('input[data-server-id="1"][value="context"]').check();
  await page.locator('input[data-server-id="3"][value="exec"]').uncheck();
  await page.locator('input[data-server-id="3"][value="write"]').check();
  await page.locator('#mcp-save-config').click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual({ grants: [{ serverId: 1, scopes: ['read', 'context'] }, { serverId: 3, scopes: ['write'] }] });
  expect(state.created).toBe(1);
  await page.locator('#mcp-view-config').click();
  await expect(page.locator('#mcp-client-config')).toHaveValue(new RegExp(token));
  expect((await new AxeBuilder({ page }).include('#mcp-dialog').analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await openPanel(page);
  await expect(page.locator('#mcp-client-config')).toHaveCount(0);
  await expect(page.locator('input[data-server-id="1"][value="context"]')).toBeChecked();
  await page.locator('#mcp-copy-config').click();
  await expect.poll(() => state.exports).toBe(4);
  expect(state.created).toBe(1);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
});

test('closing a pending export cancels the request and never restores plaintext or copies a late result', async ({ page }) => {
  const state = await setup(page); state.info = { ...empty(), configured: true, id, grants: [{ serverId: 1, scopes: ['read'] }] };
  let started = false; let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mcp/config/credentials', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    started = true; await paused; await route.fulfill({ json: { token } }).catch(() => {});
  });
  await page.goto('/?lang=en-US'); await openPanel(page);
  await page.locator('#mcp-copy-config').click(); await expect.poll(() => started).toBe(true);
  await page.locator('#mcp-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  release(); await openPanel(page);
  await expect(page.locator('#mcp-client-config')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__mcpCopies)).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
});

test('activity records and each operation default to collapsed; reads are lazy and stop when collapsed', async ({ page }) => {
  const state = await setup(page); await page.goto('/?lang=en-US'); await openPanel(page);
  const section = page.locator('#mcp-activity-section');
  await expect(section).not.toHaveAttribute('open', ''); expect(state.activityReads).toBe(0);
  await section.locator(':scope > summary').click();
  await expect(section.locator('.mcp-operation')).toHaveCount(1);
  await expect(section.locator('.mcp-operation')).not.toHaveAttribute('open', '');
  await expect(section.locator('.mcp-operation > p')).toBeHidden();
  await section.locator('.mcp-operation > summary').click();
  await expect(section.locator('.mcp-operation > p')).toContainText('sftp_read');
  await section.locator(':scope > summary').click();
  const count = state.activityReads;
  await page.clock.install(); await page.clock.runFor(6000); expect(state.activityReads).toBe(count);
});

test('explicit context sharing still checks server state on reopen', async ({ page }) => {
  await setup(page);
  await page.route('**/api/servers/1/memory', route => route.request().method() === 'GET' ? route.fulfill({ json: { workLogs: [], knowledge: [] } }) : route.fallback());
  const updates: any[] = []; let expiresAt = 0;
  await page.route('**/api/mcp/context', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON(); updates.push(body);
    if (typeof body.enabled === 'boolean') expiresAt = body.enabled ? Date.now() + 1800_000 : 0;
    return route.fulfill({ json: { expiresAt } });
  });
  await page.routeWebSocket('**/api/ssh*', socket => {
    socket.send(JSON.stringify({ type: 'session_created', sessionId: session, resumeToken: 'not-a-context-token' }));
    socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: 'ready' }));
    socket.onMessage(data => { if (typeof data !== 'string') return; try { const msg = JSON.parse(data); if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', id: msg.id })); } catch { /* shell data */ } });
  });
  await page.goto('/?lang=en-US'); await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(async () => {
    const { getTabManager } = await (window as any).eval("import('/src/main.ts')");
    const tab = getTabManager().createTab('Shared tab', { host: 'ssh.example.com', port: 22, serverId: 1 });
    tab.terminal.connectWithWebSocket(new WebSocket(`ws://${location.host}/api/ssh?token=e2e`), tab.hostInfo);
  });
  await openPanel(page); expect(updates).toHaveLength(0);
  await page.locator('#mcp-context-section > summary').click();
  await expect(page.getByRole('button', { name: 'Share recent output', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Share recent output', exact: true }).click();
  await expect(page.getByLabel('Context arguments for your assistant')).toHaveValue(new RegExp(session));
  await page.locator('#mcp-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await openPanel(page); await page.locator('#mcp-context-section > summary').click();
  await page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await expect(page.getByLabel('Context arguments for your assistant')).toBeHidden();
  expect(JSON.stringify(updates)).not.toContain('not-a-context-token');
});

for (const [locale, title] of [['zh-CN', '外部助手'], ['zh-TW', '外部助理'], ['en-US', 'External assistants']]) {
  test(`compact singleton panel and accessible icons (${locale})`, async ({ page }) => {
    await setup(page); await page.goto(`/?lang=${locale}`); await openPanel(page);
    await expect(page.locator('#mcp-title')).toHaveText(title);
    await expect(page.locator('#user-space-header-actions [data-mcp-open]')).toHaveAttribute('aria-label', title);
    await expect(page.locator('#ai-config-btn svg[data-assistant-glyph="agent"]')).toBeAttached();
    expect(await page.locator('#mcp-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
    await page.keyboard.press('Escape'); await expect(page.locator('#mcp-dialog')).toHaveCount(0);
  });
}

test('anonymous pages do not expose MCP entry points', async ({ page }) => {
  await page.goto('/?lang=en-US');
  for (const button of await page.locator('[data-mcp-open]').all()) await expect(button).toBeHidden();
});
