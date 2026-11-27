import { expect, test, type Page } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { mcpCopies, mockMcpClipboard, revealMcpGrant } from './helpers';
import type { McpActivity } from '../../src/mcp-schema';

const servers = [1, 3].map(id => ({ id, user_id: 1, name: `Personal server ${id}`, host: 'ssh.example.com', port: 22,
  username: 'deploy', auth_method: 'password', tags: [] as string[], os: null, region: null, created_at: '', updated_at: '' }));
const id = '12345678-1234-4234-8234-123456789abc';
const newId = '22345678-1234-4234-8234-123456789abc';
const token = 'SINGLETON-PERSONAL-TOKEN';
const newToken = 'ROTATED-PERSONAL-TOKEN';
const session = `session:1780000000000:${id}`;
const empty = () => ({ configured: false, id: null as string | null, grants: [] as { serverId: number; scopes: string[] }[], hasAccessCredentials: false, legacy: false });

async function setup(page: Page, inventory = servers) {
  await page.route('**/api/config', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github',
  } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'tester', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET' ? route.fulfill({ json: inventory }) : route.fallback());
  const state = { info: empty(), created: 0, writes: [] as any[], exports: 0, activityReads: 0,
    rotations: [] as unknown[], configReads: 0, token };
  await page.route('**/api/mcp/config', route => {
    const method = route.request().method();
    if (method === 'GET') {
      state.configReads++;
      return route.fulfill({ json: state.info });
    }
    if (!['POST', 'PUT'].includes(method)) return route.fallback();
    const body = route.request().postDataJSON(); state.writes.push(body);
    if (method === 'POST' && !state.info.configured) state.created++;
    state.info = { ...state.info, configured: true, id: state.info.id ?? id, grants: body.grants, legacy: false };
    return route.fulfill({ json: state.info });
  });
  await page.route('**/api/mcp/config/rotate', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    state.rotations.push(body);
    expect((await route.request().allHeaders()).origin).toBe(new URL(route.request().url()).origin);
    if (body.expectedId !== state.info.id) return route.fulfill({ status: 409, json: { error: 'mcp_config_changed' } });
    state.info.id = newId;
    state.token = newToken;
    return route.fulfill({ json: { id: newId } });
  });
  await page.route('**/api/mcp/config/credentials', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.exports++; return route.fulfill({ json: { token: state.token } });
  });
  await page.route('**/api/mcp/activity', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    state.activityReads++; return route.fulfill({ json: [{ id: 'op', client: 'MCP', serverId: 1, tool: 'sftp_read', status: 'success', startedAt: Date.now(), finishedAt: Date.now() }] });
  });
  await mockMcpClipboard(page);
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
  await expect(dialog.getByRole('button', { name: 'View configuration' })).toHaveCount(0);
  await expect(page.locator('#mcp-rotate-key')).toBeHidden();
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
  await expect.poll(async () => (await mcpCopies(page)).length).toBe(1);
  await page.locator('#mcp-copy-config').click();
  await expect.poll(async () => (await mcpCopies(page)).length).toBe(2);
  await expect(page.locator('#mcp-save-config')).toBeDisabled();
  const copies = await mcpCopies(page);
  expect(copies[0]).toBe(copies[1]); expect(JSON.parse(copies[0]).mcpServers.cloudssh.headers.Authorization).toBe(`Bearer ${token}`);
  await page.locator('input[data-server-id="1"][value="context"]').check();
  await page.locator('input[data-server-id="3"][value="exec"]').uncheck();
  await page.locator('input[data-server-id="3"][value="write"]').check();
  await page.locator('#mcp-save-config').click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual({ grants: [{ serverId: 1, scopes: ['read', 'context'] }, { serverId: 3, scopes: ['write'] }] });
  expect(state.created).toBe(1);
  await page.locator('#mcp-copy-config').click();
  await expect.poll(async () => (await mcpCopies(page)).length).toBe(3);
  await expect(dialog.locator('textarea')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('#mcp-dialog').analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await openPanel(page);
  expect(state.exports).toBe(3);
  await revealMcpGrant(page, 1);
  await expect(page.locator('input[data-server-id="1"][value="context"]')).toBeChecked();
  await page.locator('#mcp-copy-config').click();
  await expect.poll(() => state.exports).toBe(4);
  expect(state.created).toBe(1);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
});

test('rotate requires confirmation and keeps the permission draft; only explicit copy exports the new key', async ({ page }) => {
  const state = await setup(page);
  state.info = { ...empty(), configured: true, id, grants: [{ serverId: 1, scopes: ['read'] }] };
  await page.goto('/?lang=en-US'); await openPanel(page);
  const dialog = page.locator('#mcp-dialog');
  const confirm = page.locator('dialog.app-dialog');
  const rotate = dialog.getByRole('button', { name: 'Rotate MCP key', exact: true });
  const save = page.locator('#mcp-save-config');
  await expect(save).toBeDisabled();
  await revealMcpGrant(page, 1);
  const write = page.locator('input[data-server-id="1"][value="write"]');
  await write.check();
  await expect(save).toBeEnabled();
  await rotate.click();
  await expect(confirm).toContainText('The old key will stop working immediately');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(state.rotations).toEqual([]);
  await rotate.click();
  await confirm.getByRole('button', { name: 'Rotate MCP key' }).click();
  await expect(dialog.getByRole('status')).toContainText('MCP key rotated');
  expect(state.rotations).toEqual([{ expectedId: id }]);
  expect(state.writes).toEqual([]);
  expect(state.exports).toBe(0);
  expect(await mcpCopies(page)).toEqual([]);
  await expect(write).toBeChecked();
  await expect(save).toBeEnabled();
  await write.uncheck();
  await expect(save).toBeDisabled();
  await dialog.getByRole('button', { name: 'Copy MCP configuration' }).click();
  await expect.poll(async () => (await mcpCopies(page)).length).toBe(1);
  const [config] = await mcpCopies(page);
  expect(JSON.parse(config).mcpServers.cloudssh.headers.Authorization).toBe(`Bearer ${newToken}`);
  await expect(dialog).not.toContainText(newToken);
});

for (const outcome of ['conflict', 'response lost']) {
  test(`rotation reconciles the metadata once without a second write (${outcome})`, async ({ page }) => {
    const state = await setup(page);
    state.info = { ...empty(), configured: true, id };
    await page.route('**/api/mcp/config/rotate', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      state.rotations.push(route.request().postDataJSON());
      state.info.id = newId;
      return outcome === 'conflict'
        ? route.fulfill({ status: 409, json: { error: 'mcp_config_changed' } })
        : route.abort('failed');
    });
    await page.goto('/?lang=en-US'); await openPanel(page);
    await page.locator('#mcp-rotate-key').click();
    await page.locator('dialog.app-dialog').getByRole('button', { name: 'Rotate MCP key' }).click();
    await expect(page.locator('#mcp-dialog [role="status"]')).toContainText('The MCP key has changed');
    expect(state.configReads).toBe(2);
    expect(state.rotations).toEqual([{ expectedId: id }]);
    expect(state.exports).toBe(0);
  });
}

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
  await page.locator('#mcp-activity-server').selectOption('1');

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
  await expect(page.locator('#mcp-activity-server')).toHaveValue('');
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
  expect(await mcpCopies(page)).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
});

for (const [locale, label] of [['zh-CN', '服务器'], ['zh-TW', '伺服器'], ['en-US', 'Server']]) {
  test(`activity filter keeps the full label and wraps controls without overflow (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 680 });
    await setup(page, servers.map(server => ({ ...server, name: `Unusually long server name ${server.id} `.repeat(3) })));
    await page.goto(`/?lang=${locale}`); await openPanel(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    const section = page.locator('#mcp-activity-section');
    await section.locator(':scope > summary').click();
    const select = section.getByRole('combobox', { name: label, exact: true });
    await expect(select).toBeVisible();
    const layout = await section.locator('.mcp-activity-toolbar').evaluate(toolbar => {
      const scope = toolbar.querySelector('label')!;
      const caption = scope.querySelector('span')!;
      const range = document.createRange();
      range.selectNodeContents(caption);
      const text = range.getBoundingClientRect();
      const captionBox = caption.getBoundingClientRect();
      const bounds = toolbar.getBoundingClientRect();
      const select = scope.querySelector('select')!.getBoundingClientRect();
      return {
        lines: range.getClientRects().length,
        complete: text.right <= captionBox.right + 1 && text.right < select.left,
        selectFits: select.right <= bounds.right + 1 && select.height >= 44,
        overflow: toolbar.scrollWidth > toolbar.clientWidth + 1,
        wrapped: [...toolbar.querySelectorAll('button')].some(button => button.offsetTop > scope.offsetTop + 8),
      };
    });
    expect(layout).toEqual({ lines: 1, complete: true, selectFits: true, overflow: false, wrapped: true });
    await select.selectOption('3');
    await expect(select).toHaveValue('3');
  });
}

test('expanded activity shows two compact log lines without nested disclosures; collapsing stops reads', async ({ page }) => {
  const state = await setup(page); await page.goto('/?lang=zh-CN');
  const started = await page.evaluate(() => new Date(2026, 10, 16, 17, 3, 13).getTime());
  await page.route('**/api/mcp/activity', route => {
    if (route.request().method() !== 'GET') return route.fallback();
    state.activityReads++;
    return route.fulfill({ json: [
      { id: 'op-b', client: 'MCP', serverId: 3, tool: 'ssh_exec', status: 'unknown', failureReason: 'exec_transport_closed', startedAt: started, finishedAt: started + 1000 },
      { id: 'op-a', client: 'MCP', serverId: 1, tool: 'ssh_exec', status: 'error', failureReason: 'private upstream diagnostic', startedAt: started - 6000, finishedAt: started - 3000 },
    ] });
  });
  await openPanel(page);
  const section = page.locator('#mcp-activity-section');
  await expect(section).not.toHaveAttribute('open', ''); expect(state.activityReads).toBe(0);
  await section.locator(':scope > summary').click();
  const rows = section.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(section.getByRole('heading', { name: '2026/11/16' })).toHaveCount(1);
  await expect(rows.nth(0)).toHaveText(/^17:03:13 · Personal server 3 · SSH 执行 · 结果未知 · SSH 连接关闭 · 1\s*秒$/);
  await expect(rows.nth(1)).toHaveText(/^17:03:07 · Personal server 1 · SSH 执行 · 未执行 · 3\s*秒$/);
  await expect(section.locator('#mcp-activity-list details, #mcp-activity-list summary')).toHaveCount(0);
  expect(await rows.first().evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeLessThan(13);
  expect(await rows.first().evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(28);
  expect(await page.locator('#mcp-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await section.locator(':scope > summary').click();
  const count = state.activityReads;
  await page.clock.install(); await page.clock.runFor(6000); expect(state.activityReads).toBe(count);
});

test('MCP activity merges adjacent successes and keeps writes, exceptions and raw records accessible', async ({ page }) => {
  await setup(page);
  const base = await page.evaluate(() => new Date(2026, 10, 25, 16, 49, 0).getTime());
  const log = (id: string, offset: number, duration: number, extra: Partial<McpActivity> = {}): McpActivity => ({
    id, serverId: 1, client: 'MCP', tool: 'ssh_exec', status: 'success',
    startedAt: base + offset, finishedAt: base + offset + duration, ...extra,
  });
  const items = [
    log('latest', 42_123, 233), log('second', 40_000, 1700),
    log('write-a', 38_000, 500, { tool: 'sftp_write' }), log('write-b', 37_000, 1000, { tool: 'sftp_write' }),
    log('unknown', 36_000, 8000, { status: 'unknown', failureReason: 'exec_timeout' }),
    log('nonzero', 35_000, 500, { status: 'failed' }), log('old-error', 34_000, 250, { status: 'error' }),
    log('other-server', 33_000, 500, { serverId: 3, tool: 'sftp_list' }),
  ];
  await page.route('**/api/mcp/activity', route => route.request().method() === 'GET'
    ? route.fulfill({ json: items }) : route.fallback());
  await page.goto('/?lang=zh-CN');
  await openPanel(page);
  await page.locator('#mcp-activity-section > summary').click();
  const list = page.locator('#mcp-activity-list');
  const rows = list.getByRole('listitem');
  const raw = page.getByRole('button', { name: '查看逐条记录' });
  const onlyAnomalies = page.locator('#mcp-activity-anomalies');
  const filter = page.getByRole('combobox', { name: '服务器', exact: true });
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toHaveText(/16:49:40 – 16:49:42 · Personal server 1 · SSH 执行 ×2 · 最慢 1\.7\s*秒/);
  await expect(rows.filter({ hasText: 'SFTP 写入' })).toHaveCount(2);
  await expect(rows.filter({ hasText: '命令执行超时' })).toHaveCount(1);
  await expect(onlyAnomalies).toHaveText('只看异常（3）');
  await filter.selectOption('1');
  await expect(list.getByRole('heading', { name: '2026/11/25 · Personal server 1' })).toBeVisible();
  await expect(rows.first()).not.toContainText('Personal server 1');
  await expect(rows).toHaveCount(6);
  await raw.click();
  await expect(raw).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toHaveText(/16:49:42\.123 – 16:49:42\.356 · ssh_exec · 已完成/);
  await onlyAnomalies.click();
  await expect(onlyAnomalies).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('非零退出');
  await expect(rows.nth(2)).toContainText('未执行');
  await filter.selectOption('3');
  await expect(onlyAnomalies).toHaveText('只看异常（0）');
  await expect(list).toHaveText('近期操作没有异常。');
  await onlyAnomalies.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('sftp_list');
});

test('activity log exposes all 100 bounded records in a scrollable area', async ({ page }) => {
  await setup(page);
  const now = await page.evaluate(() => new Date(2026, 10, 25, 12).getTime());
  await page.route('**/api/mcp/activity', route => route.request().method() === 'GET' ? route.fulfill({ json:
    Array.from({ length: 100 }, (_, index) => ({ id: `log-${index}`, client: 'MCP', serverId: 1, tool: 'ssh_exec',
      status: 'success', startedAt: now - index * 2000, finishedAt: now - index * 2000 + 1000 })) }) : route.fallback());
  await page.goto('/?lang=en-US'); await openPanel(page);
  await page.locator('#mcp-activity-section > summary').click();
  await expect(page.locator('#mcp-activity-list').getByRole('listitem')).toHaveCount(1);
  await expect(page.locator('#mcp-activity-list').getByRole('listitem')).toContainText('×100');
  await page.locator('#mcp-activity-raw').click();
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
