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

test('MCP and Agent share header, field and footer components in all themes', async ({ page }) => {
  await setup(page);
  await page.route('**/api/servers/1/memory', route => route.request().method() === 'GET' ? route.fulfill({ json: { workLogs: [], knowledge: [] } }) : route.fallback());
  await page.goto('/?lang=en-US'); await expect(page.locator('#app')).toBeVisible();
  await open(page);
  await page.evaluate(async () => {
    const { AgentPanel } = await (window as any).eval("import('/src/agent/agent-panel.ts')");
    const panel = new AgentPanel(document.body, true, 1, 42); panel.render(); panel.show();
    (window as any).__sharedUiAgent = panel;
  });
  const colors = new Set<string>();
  for (const theme of ['standard-dark', 'standard-light', 'cyberpunk', 'liquid-glass']) {
    await page.evaluate(async name => { const { applyBuiltInTheme } = await (window as any).eval("import('/src/theme.ts')"); applyBuiltInTheme(name); }, theme);
    const style = await page.locator('.mcp-dialog__panel').evaluate(node => {
      const css = getComputedStyle(node); return { color: css.color, background: css.backgroundColor,
        radius: parseFloat(css.borderTopLeftRadius), shadow: css.boxShadow, filter: css.backdropFilter,
        mobile: matchMedia('(max-width: 767px), (max-width: 1180px) and (pointer: coarse)').matches };
    });
    colors.add(style.background);
    const components = await page.evaluate(() => {
      const css = (selector: string, keys: string[]) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return keys.map(key => style.getPropertyValue(key));
      };
      return {
        mcpSurface: css('.mcp-dialog__panel', ['background-color', 'backdrop-filter']),
        agentSurface: css('#agent-panel', ['background-color', 'backdrop-filter']),
        mcpHeader: css('.mcp-dialog .assistant-panel-header', ['height','padding-left','background-color','border-bottom-color']),
        agentHeader: css('#agent-panel .assistant-panel-header', ['height','padding-left','background-color','border-bottom-color']),
        mcpTitle: css('#mcp-title', ['font-family','font-size','font-weight','letter-spacing','color']),
        agentTitle: css('#agent-panel .assistant-panel-title', ['font-family','font-size','font-weight','letter-spacing','color']),
        mcpField: css('#mcp-access-client-id', ['font-size','border-radius','padding','background-color','border-bottom-color']),
        agentField: css('#agent-input', ['font-size','border-radius','padding','background-color','border-bottom-color']),
        mcpFooter: css('.mcp-actions', ['background-color','border-top-color']),
        agentFooter: css('#agent-panel .assistant-panel-footer', ['background-color','border-top-color']),
      };
    });
    expect(components.mcpHeader).toEqual(components.agentHeader);
    expect(components.mcpTitle).toEqual(components.agentTitle);
    expect(components.mcpField).toEqual(components.agentField);
    expect(components.mcpFooter).toEqual(components.agentFooter);
    if (theme === 'liquid-glass') {
      // Liquid material lives on the outer shells; other themes use the Agent's inner surface.
      expect(components.mcpSurface).toEqual(components.agentSurface);
      expect(style.filter).toContain('blur');
      expect(style.radius).toBeGreaterThan(0);
      if (style.mobile) expect(style.background).toBe('rgb(255, 255, 255)');
      else expect(style.background).toContain('0.96');
    }
    await expect(page.locator('#mcp-save-config')).toBeVisible();
    expect(await page.locator('#mcp-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  }
  expect(colors.size).toBeGreaterThanOrEqual(3);
});

for (const [locale, caption] of [['zh-CN', '返回终端'], ['zh-TW', '返回終端'], ['en-US', 'Back to terminal']]) {
  test(`Agent mobile back button fits narrow screens without squeezing its label (${locale})`, async ({ page }) => {
    await setup(page);
    await page.route('**/api/servers/1/memory', route => route.request().method() === 'GET'
      ? route.fulfill({ json: { workLogs: [], knowledge: [] } }) : route.fallback());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?lang=${locale}`);
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(async () => {
      const { AgentPanel } = await (window as any).eval("import('/src/agent/agent-panel.ts')");
      const panel = new AgentPanel(document.body, true, 1, 42);
      panel.render(); panel.show();
      (window as any).__mobileBackAgent = panel;
      await document.fonts.ready;
    });
    const button = page.locator('#agent-close-btn');
    const label = button.locator('.agent-back-label');
    await expect(label).toHaveText(caption);
    await expect(button).toHaveAttribute('aria-label', caption);
    for (const theme of ['standard-dark', 'standard-light', 'cyberpunk', 'liquid-glass']) {
      await page.evaluate(async name => {
        const { applyBuiltInTheme } = await (window as any).eval("import('/src/theme.ts')");
        applyBuiltInTheme(name);
      }, theme);
      for (const width of [320, 375, 380, 381, 390, 520]) {
        await page.setViewportSize({ width, height: 844 });
        if (width <= 380) await expect(label).toBeHidden();
        else await expect(label).toBeVisible();
        await expect(button.locator('.agent-mobile-back.material-symbols-outlined')).toBeVisible();
        await expect(button.locator('.agent-desktop-close')).toBeHidden();
        await expect.poll(() => button.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const label = node.querySelector('.agent-back-label')!;
          const text = label.getBoundingClientRect();
          const header = node.closest('.assistant-panel-header')!;
          const hidden = getComputedStyle(label).display === 'none';
          return {
            touchTarget: rect.height >= 40 && rect.width >= 40,
            singleLine: hidden || text.height <= parseFloat(getComputedStyle(label).lineHeight) + 1,
            horizontalFit: hidden || (text.left >= rect.left - 1 && text.right <= rect.right + 1),
            verticalFit: hidden || (text.top >= rect.top - 1 && text.bottom <= rect.bottom + 1),
            headerFit: header.scrollWidth <= header.clientWidth + 1,
          };
        }), { message: `${locale}, ${theme}, ${width}px: label must fit its button and header` })
          .toEqual({ touchTarget: true, singleLine: true, horizontalFit: true, verticalFit: true, headerFit: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(label).toBeHidden();
    await expect(button.locator('.agent-desktop-close')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await button.click();
    await expect(page.locator('#agent-panel')).toBeHidden();
  });
}

test('Access replacements make the form dirty, but merely opening or confirming the saved settings does not', async ({ page }) => {
  const state = await setup(page); state.info = { ...state.info, configured: true, id: 'singleton', hasAccessCredentials: true };
  state.access = { clientId, clientSecret: secret };
  await page.goto('/?lang=en-US'); await open(page);
  const save = page.locator('#mcp-save-config');
  await expect(save).toBeDisabled(); await page.locator('#mcp-access-guide > summary').click();
  await expect(save).toBeDisabled(); await page.locator('#mcp-access-policy-confirmed').check();
  await expect(save).toBeDisabled();
  await page.locator('#mcp-access-client-id').fill('new.access'); await expect(save).toBeEnabled();
  await page.locator('#mcp-access-client-id').fill(''); await expect(save).toBeDisabled();
  await page.locator('#mcp-access-client-id').fill('new.access'); await page.locator('#mcp-access-client-secret').fill('new-secret');
  await save.click(); await expect.poll(() => state.writes.length).toBe(1); await expect(save).toBeDisabled();
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
