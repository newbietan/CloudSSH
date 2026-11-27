import { expect, test, type Locator } from './fixtures';

const id = '12345678-1234-1234-1234-123456789abc';

function skin(dialog: Locator) {
  return dialog.evaluate((root) => {
    const panel = root.querySelector('.app-modal__panel')!;
    const title = root.querySelector('.app-modal__title')!;
    const header = root.querySelector('.app-modal__header')!;
    const css = getComputedStyle(panel);
    const headline = getComputedStyle(title);
    const overlay = root instanceof HTMLDialogElement
      ? getComputedStyle(root, '::backdrop')
      : getComputedStyle(root.querySelector('.modal-overlay')!);
    return {
      fill: css.backgroundColor,
      frame: [css.borderTopColor, css.borderBottomColor, css.borderLeftColor, css.borderTopLeftRadius, css.boxShadow, css.backdropFilter],
      title: [headline.color, headline.fontFamily, headline.fontSize, headline.fontWeight, headline.letterSpacing],
      divider: getComputedStyle(header).borderBottomColor,
      overlay: overlay.backgroundColor,
      accent: getComputedStyle(panel, '::before').content !== 'none',
    };
  });
}

test('server, AI, MCP and Windows setup share the same modal skin in all themes', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { turnstileEnabled: false, githubAuthEnabled: true, githubAuthRequired: true, authMode: 'github', rdpEnabled: true, rdpConnectorEnabled: true } }) : route.fallback());
  await page.route('**/api/auth/me', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { id: 1, github_id: 42, username: 'test', avatar_url: null } }) : route.fallback());
  await page.route('**/api/servers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [] }) : route.fallback());
  await page.route('**/api/ai/config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { configured: false } }) : route.fallback());
  await page.route('**/api/mcp/config', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { configured: false, id: null, grants: [], hasAccessCredentials: false, legacy: false } }) : route.fallback());
  await page.route('**/api/rdp/profiles', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { profiles: [{ id, name: 'Windows test', host: '', route: 'connector', tags: [], revision: 1, fingerprint: null, hasLogin: true, hasAccessToken: false }] } }) : route.fallback());
  await page.route(`**/api/rdp/profiles/${id}/connector`, route => route.request().method() === 'GET'
    ? route.fulfill({ json: { state: 'unbound' } }) : route.fallback());
  await page.goto('/?lang=en-US');
  await expect(page.locator('#user-space-section')).toBeVisible();

  const themeSkins = new Set<string>();
  for (const theme of ['standard-dark', 'standard-light', 'cyberpunk', 'liquid-glass']) {
    await page.evaluate(async name => {
      const path = '/src/theme.ts';
      const { applyBuiltInTheme } = await import(path);
      applyBuiltInTheme(name);
    }, theme);
    const server = page.locator('#server-modal');
    await page.locator('#add-server-btn').click();
    const baseline = await skin(server);
    themeSkins.add(JSON.stringify(baseline));
    expect(baseline.accent).toBe(theme === 'cyberpunk');
    expect(parseFloat(baseline.frame[3]) === 0).toBe(theme === 'cyberpunk');
    expect(baseline.overlay).not.toBe('rgba(0, 0, 0, 0)');
    await server.getByRole('button', { name: 'Close', exact: true }).click();

    for (const [trigger, dialog] of [
      ['#ai-config-btn', '#ai-config-modal'],
      ['#user-space-header-actions [data-mcp-open]', '#mcp-dialog'],
      [`#rdp-open-${id}`, '.rdp-connector-dialog'],
    ] as const) {
      const opener = page.locator(trigger);
      const more = page.locator('#user-space-more-btn');
      if (!(await opener.isVisible()) && (await more.isVisible())) await more.click();
      await opener.click({ timeout: 6000 });
      const modal = page.locator(dialog);
      await expect(modal).toBeVisible();
      expect(await skin(modal), `${theme}: ${dialog}`).toEqual(baseline);
      if (theme === 'cyberpunk' && dialog !== '#ai-config-modal') {
        await testInfo.attach(dialog.slice(1), { body: await modal.locator('.app-modal__panel').screenshot(), contentType: 'image/png' });
      }
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toBeHidden();
    }
  }
  expect(themeSkins.size).toBe(4);
});
