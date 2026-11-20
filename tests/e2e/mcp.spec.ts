import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { revealMcpGrant } from './helpers';

const servers = [1, 3].map(id => ({ id, user_id: 1, name: `Personal server ${id}`, host: 'ssh.example.com', port: 22,
  username: 'deploy', auth_method: 'password', tags: [] as string[], os: null, region: null, created_at: '', updated_at: '' }));
const id = '12345678-1234-1234-1234-123456789abc';
const token = 'SINGLETON-PERSONAL-TOKEN';
const session = `session:1780000000000:${id}`;
const empty = () => ({ configured: false, id: null as string | null, grants: [] as { serverId: number; scopes: string[] }[], hasAccessCredentials: false, legacy: false });

async function setup(page: Page, inventory = servers) {
  await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github',
  } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET' ? route.fulfill({ json: inventory }) : route.fallback());
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

for (const locale of ['zh-CN', 'zh-TW', 'en-US']) {
  test(`移动更多菜单MCP紧邻Agent且主题和字号不重叠：${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page);
    await page.goto(`/?lang=${locale}`);
    await expect(page.locator('#user-space-section')).toBeVisible();
    await page.evaluate(async () => {
      const modulePath = '/src/main.ts';
      const { showTerminalWithNewTab } = await import(modulePath);
      showTerminalWithNewTab('Mobile menu');
    });
    await page.locator('#mobile-more-btn').click();
    const menu = page.locator('#mobile-more-menu');
    const mcp = menu.locator('[data-mcp-open]');
    await expect(mcp).not.toHaveClass(/hidden/);
    const layout = await menu.evaluate((el) => {
      const children = [...el.children].filter((child) => child.getClientRects().length > 0);
      const rects = children.map((child) => child.getBoundingClientRect());
      const theme = el.querySelector('.mobile-more-theme-row')!.getBoundingClientRect();
      const select = el.querySelector('#mobile-theme-selector')!.getBoundingClientRect();
      const font = el.querySelector('.mobile-font-controls')!.getBoundingClientRect();
      return {
        previous: el.querySelector('[data-mcp-open]')!.previousElementSibling?.id,
        overlap: rects.some((rect, i) => i > 0 && rect.top < rects[i - 1].bottom - 0.5),
        themeOverflow: select.bottom - theme.bottom,
        fontOverlap: select.bottom - font.top,
        scrollable: el.scrollHeight > el.clientHeight,
      };
    });
    expect(layout.previous).toBe('mobile-agent-btn');
    expect(layout.overlap).toBe(false);
    expect(layout.themeOverflow).toBeLessThanOrEqual(0);
    expect(layout.fontOverlap).toBeLessThanOrEqual(0);
    expect(layout.scrollable).toBe(true);
    await mcp.click();
    await expect(page.locator('#mcp-config-form')).toBeVisible();
    await expect(menu).toBeHidden();
  });
}

test('one permanent configuration: generate once, repeatedly copy, change separate server permissions, and reopen without rotation', async ({ page }) => {
  const state = await setup(page);
  state.info.legacy = true;
  await page.goto('/?lang=en-US'); await openPanel(page);
  const dialog = page.locator('#mcp-dialog');
  await expect(dialog.locator('[data-i18n="mcp.compactIntro"], [data-i18n="mcp.legacyHint"], [data-i18n="mcp.help"], [data-i18n="mcp.shortSafety"]')).toHaveCount(0);
  await expect(page.locator('input[name="name"], input[name="days"], #mcp-token-list, #mcp-access-guide')).toHaveCount(0);
  await expect(dialog).not.toContainText('Revoke');
  await expect(page.locator('#mcp-copy-config')).toBeDisabled();
  await revealMcpGrant(page, 1);
  await page.locator('input[data-server-id="1"][value="read"]').check();
  await revealMcpGrant(page, 3);
  await page.locator('input[data-server-id="3"][value="exec"]').check();
  await page.locator('#mcp-save-config').click();
  await expect.poll(() => state.created).toBe(1);
  expect(state.writes[0]).toEqual({ grants: [{ serverId: 1, scopes: ['read'] }, { serverId: 3, scopes: ['exec'] }] });
  await expect(page.locator('#mcp-copy-config')).toBeEnabled(); expect(state.exports).toBe(0);
  await expect(page.locator('#mcp-save-config')).toBeDisabled();
  await page.locator('#mcp-copy-config').click();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpCopies.length)).toBe(1);
  await page.locator('#mcp-copy-config').click();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpCopies.length)).toBe(2);
  await expect(page.locator('#mcp-save-config')).toBeDisabled();
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
  await revealMcpGrant(page, 1);
  await expect(page.locator('input[data-server-id="1"][value="context"]')).toBeChecked();
  await page.locator('#mcp-copy-config').click();
  await expect.poll(() => state.exports).toBe(4);
  expect(state.created).toBe(1);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
});

test('saved grants stay disabled until changed; reverting, exports and failed saves preserve the baseline', async ({ page }) => {
  const state = await setup(page); state.info = { ...empty(), configured: true, id, grants: [{ serverId: 1, scopes: ['read'] }] };
  let started = false; let release!: () => void;
  const pause = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mcp/config/credentials', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    started = true; await pause; await route.fulfill({ json: { token } });
  });
  await page.goto('/?lang=en-US'); await openPanel(page);
  const save = page.locator('#mcp-save-config'); const write = page.locator('input[data-server-id="1"][value="write"]');
  await expect(save).toBeDisabled(); await expect(save).toHaveAttribute('title', 'No unsaved changes');
  await revealMcpGrant(page, 1);
  await write.check(); await expect(save).toBeEnabled(); await write.uncheck(); await expect(save).toBeDisabled();
  await page.locator('#mcp-copy-config').click(); await expect.poll(() => started).toBe(true);
  await write.check(); await expect(save).toBeDisabled();
  release(); await expect(save).toBeEnabled();
  await page.route('**/api/mcp/config', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, json: { error: 'failed' } }) : route.fallback());
  await save.click(); await expect(page.locator('#mcp-dialog [role="status"]')).toContainText('Request failed');
  await expect(save).toBeEnabled(); await write.uncheck(); await expect(save).toBeDisabled();
});

test('48 servers: search and saved-access filters preserve the full draft and submit only on explicit save', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const inventory = Array.from({ length: 48 }, (_, i) => ({
    ...servers[0], id: i + 1, name: `Fleet ${i + 1}`, tags: [i === 16 || i === 29 ? 'Blue-Team' : 'Lab'],
  }));
  const state = await setup(page, inventory);
  state.info = { ...empty(), configured: true, id, grants: [
    { serverId: 1, scopes: ['read'] }, { serverId: 30, scopes: ['exec', 'read'] }, { serverId: 48, scopes: ['context'] },
  ] };
  await page.goto('/?lang=en-US'); await openPanel(page);
  const editor = page.locator('#mcp-permissions');
  const heading = editor.locator(':scope > summary');
  const save = page.locator('#mcp-save-config');
  await expect(heading).toContainText('3 / 48 authorized');
  await expect(editor).not.toHaveAttribute('open', '');
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  await heading.click();
  const table = editor.getByRole('table', { name: 'Server permissions' });
  await expect(table.getByRole('columnheader')).toHaveCount(5);
  await expect(table.getByRole('rowheader')).toHaveCount(48);
  const list = editor.locator('.mcp-grant-list');
  expect(await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop > 0 && Math.abs(el.querySelector('thead th')!.getBoundingClientRect().top - el.getBoundingClientRect().top) <= 2;
  })).toBe(true);
  const search = editor.getByRole('searchbox');
  const filter = editor.getByRole('combobox');
  await search.fill('  bLuE-tEam '); await expect(table.getByRole('rowheader')).toHaveCount(2);
  await filter.selectOption('unauthorized'); await expect(table.getByRole('rowheader')).toHaveText('Fleet 17');
  await table.getByRole('checkbox', { name: 'Fleet 17 · Read', exact: true }).check();
  await table.getByRole('checkbox', { name: 'Fleet 17 · Write', exact: true }).check();
  await expect(save).toHaveText('Save changes (1)');
  await expect(heading).toContainText('4 / 48 authorized after saving');
  await filter.selectOption('authorized'); await expect(table.getByRole('rowheader')).toHaveText('Fleet 30');
  await table.getByRole('checkbox', { name: 'Fleet 30 · Execute', exact: true }).uncheck();
  await search.fill('not in inventory'); await search.press('Enter');
  await expect(editor.getByText(/No matching servers/)).toBeVisible();
  await expect(save).toHaveText('Save changes (2)');
  await heading.click(); await heading.click();
  await expect(search).toHaveValue('not in inventory');
  await search.fill('fleet 17'); await filter.selectOption('unauthorized');
  await expect(table.getByRole('checkbox', { name: 'Fleet 17 · Write', exact: true })).toBeChecked();
  await heading.click();
  expect(state.writes).toHaveLength(0); expect(state.exports).toBe(0);
  await save.click(); await expect(save).toBeDisabled();
  expect(state.writes).toEqual([{ grants: [
    { serverId: 1, scopes: ['read'] }, { serverId: 17, scopes: ['read', 'write'] },
    { serverId: 30, scopes: ['read'] }, { serverId: 48, scopes: ['context'] },
  ] }]);
  await expect(heading).toContainText('4 / 48 authorized');
  await heading.click(); await expect(editor.getByText(/No matching servers/)).toBeVisible();
  await filter.selectOption('authorized'); await expect(table.getByRole('rowheader')).toHaveText('Fleet 17');
});

test('mobile disclosures preserve selections through resize and allow full revocation without sharing context', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const state = await setup(page);
  state.info = { ...empty(), configured: true, id, grants: [{ serverId: 1, scopes: ['read'] }] };
  await page.goto('/?lang=zh-CN'); await openPanel(page);
  const editor = page.locator('#mcp-permissions');
  const save = page.locator('#mcp-save-config');
  await editor.locator(':scope > summary').click();
  const row = editor.locator('details[data-grant-id="1"]');
  await expect(row.locator('summary')).toContainText('读取');
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  await row.locator('summary').click();
  const read = editor.getByRole('checkbox', { name: 'Personal server 1 · 读取', exact: true });
  await read.uncheck();
  await expect(row.locator('summary')).toContainText('未授权');
  await expect(save).toHaveText('保存修改（1 台）');
  expect(await page.locator('#mcp-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await row.locator('label').first().evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1280, height: 800 }); await expect(editor.getByRole('table')).toBeVisible();
  await expect(read).not.toBeChecked(); await read.check(); await expect(save).toBeDisabled();
  await read.uncheck(); await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.locator('summary')).toContainText('未授权');
  await save.click(); await expect(save).toBeDisabled();
  expect(state.writes).toEqual([{ grants: [] }]);
});

test('confirmed server removal updates other open and loading MCP views without losing unrelated edits', async ({ page, context }) => {
  const inventory = [...servers];
  const state = await setup(page, inventory);
  state.info = { ...empty(), configured: true, id, grants: inventory.map(({ id }) => ({ serverId: id, scopes: ['read'] })) };
  await page.goto('/?lang=en-US'); await openPanel(page);
  await revealMcpGrant(page, 1);
  await page.locator('input[data-server-id="1"][value="context"]').check();
  await revealMcpGrant(page, 3);
  const write = page.locator('input[data-server-id="3"][value="write"]');
  await write.check();
  const save = page.locator('#mcp-save-config');
  await expect(save).toHaveText('Save changes (2)');
  await page.locator('#mcp-activity-section > summary').click();
  await expect(page.locator('#mcp-activity-list')).toContainText('Personal server 1');

  const owner = await context.newPage(); await setup(owner, inventory);
  let badResponse = true;
  await owner.route(/\/api\/servers\/\d+$/, route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    if (badResponse) return route.fulfill({ contentType: 'text/html', body: '<title>Sign in</title>' });
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    inventory.splice(inventory.findIndex(s => s.id === id), 1);
    state.info.grants = state.info.grants.filter(g => g.serverId !== id);
    return route.fulfill({ json: { success: true } });
  });
  await owner.goto('/?lang=en-US');
  const remove = async (id: number) => {
    await owner.locator(`#delete-${id}`).click();
    await owner.locator('.app-dialog__button--confirm').click();
  };
  await remove(1);
  await expect(owner.locator('.app-toast').last()).toBeVisible();
  await expect(owner.locator('#card-1')).toBeVisible(); await expect(save).toHaveText('Save changes (2)');
  badResponse = false; await remove(1);
  await expect(owner.locator('#card-1')).toHaveCount(0);
  await expect(page.locator('#mcp-permissions [data-grant-id="1"]')).toHaveCount(0);
  await expect(page.locator('#mcp-activity-list')).not.toContainText('Personal server 1');
  await expect(write).toBeChecked(); await expect(save).toHaveText('Save changes (1)');
  await save.click(); await expect(save).toBeDisabled();
  expect(state.writes).toEqual([{ grants: [{ serverId: 3, scopes: ['read', 'write'] }] }]);

  // A response captured before a second deletion must not reintroduce even the last server.
  await page.locator('#mcp-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  let release!: () => void; let started!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/servers', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const stale = [...inventory]; started(); await paused; await route.fulfill({ json: stale });
  });
  const opening = openPanel(page); await requested;
  try { await remove(3); await expect(owner.locator('#card-3')).toHaveCount(0); }
  finally { release(); }
  await opening;
  await expect(page.locator('#mcp-permissions > summary')).toContainText('0 / 0 authorized');
  await page.locator('#mcp-permissions > summary').click();
  await expect(page.locator('[data-i18n="mcp.noServers"]')).toBeVisible();
  await expect(save).toBeDisabled(); await owner.close();
});

test('no saved servers: first configuration is expanded, with a distinct empty state', async ({ page }) => {
  const state = await setup(page, []);
  await page.goto('/?lang=zh-TW'); await openPanel(page);
  const editor = page.locator('#mcp-permissions');
  await expect(editor).toHaveAttribute('open', '');
  await expect(editor.locator('[data-i18n="mcp.noServers"]')).toBeVisible();
  await expect(editor.getByRole('searchbox')).toHaveCount(0);
  await expect(page.locator('#mcp-save-config')).toBeEnabled();
  expect(state.writes).toHaveLength(0);
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

test('expanded activity shows two compact log lines without nested disclosures; collapsing stops reads', async ({ page }) => {
  const state = await setup(page); await page.goto('/?lang=zh-CN');
  const started = await page.evaluate(() => new Date(2026, 10, 16, 17, 3, 13).getTime());
  await page.route('**/api/mcp/activity', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    state.activityReads++;
    return route.fulfill({ json: [
      { id: 'op-b', client: 'MCP', serverId: 3, tool: 'ssh_exec', status: 'success', startedAt: started, finishedAt: started + 1000 },
      { id: 'op-a', client: 'MCP', serverId: 1, tool: 'ssh_exec', status: 'success', startedAt: started - 6000, finishedAt: started - 3000 },
    ] });
  });
  await openPanel(page);
  const section = page.locator('#mcp-activity-section');
  await expect(section).not.toHaveAttribute('open', ''); expect(state.activityReads).toBe(0);
  await section.locator(':scope > summary').click();
  const rows = section.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText(/2026\/11\/16 17:03:13 — 17:03:14\s+Personal server 3 · 已完成\s+ssh_exec/);
  await expect(rows.nth(1)).toHaveText(/2026\/11\/16 17:03:07 — 17:03:10\s+Personal server 1 · 已完成\s+ssh_exec/);
  await expect(section.locator('#mcp-activity-list details, #mcp-activity-list summary')).toHaveCount(0);
  expect(await rows.first().evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeLessThan(13);
  expect(await rows.first().evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(28);
  expect(await page.locator('#mcp-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await section.locator(':scope > summary').click();
  const count = state.activityReads;
  await page.clock.install(); await page.clock.runFor(6000); expect(state.activityReads).toBe(count);
});

test('activity log exposes all 100 bounded records in a scrollable area', async ({ page }) => {
  await setup(page);
  await page.route('**/api/mcp/activity', route => route.request().method() === 'GET' ? route.fulfill({ json:
    Array.from({ length: 100 }, (_, index) => ({ id: `log-${index}`, client: 'MCP', serverId: 1, tool: 'ssh_exec',
      status: 'success', startedAt: Date.now() - index * 2000, finishedAt: Date.now() - index * 2000 + 1000 })) }) : route.fallback());
  await page.goto('/?lang=en-US'); await openPanel(page);
  await page.locator('#mcp-activity-section > summary').click();
  await expect(page.locator('#mcp-activity-list').getByRole('listitem')).toHaveCount(100);
  expect(await page.locator('#mcp-activity-list').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
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

test('anonymous pages do not expose MCP entry points', async ({ page }) => {
  await page.goto('/?lang=en-US');
  for (const button of await page.locator('[data-mcp-open]').all()) await expect(button).toBeHidden();
});
