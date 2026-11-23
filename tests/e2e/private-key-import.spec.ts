import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { blockOptionalThirdPartyAssets, mockAnonymousSession } from './helpers';

const fixture = (name: string) => readFileSync(join(__dirname, '../ssh/fixtures', name), 'utf8');
const passphrase = 'cloudssh-fixture-passphrase';

for (const name of ['id_ed25519_encrypted', 'id_rsa_pkcs8_aes256_encrypted.pem']) {
  test(`匿名连接在浏览器解锁且不记忆口令或解锁私钥 (${name})`, async ({ page }) => {
    await mockAnonymousSession(page);
    await page.route('**/api/known-hosts?**', (route) => route.request().method() === 'GET'
      ? route.fulfill({ status: 401, json: { error: 'unauthorized' } }) : route.fallback());
    const configs: Array<Record<string, unknown>> = [];
    await page.routeWebSocket('**/api/ssh*', (socket) => {
      socket.onMessage((data) => {
        if (typeof data !== 'string') return;
        const config = JSON.parse(data);
        if (!config.host) return;
        configs.push(config);
        socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: '' }));
      });
    });
    await page.goto('/?lang=zh-CN');
    await expect(page.locator('#auth-password-hint')).toHaveCount(0);
    await expect(page.locator('#copyright-year').locator('..')).toHaveText(`© ${new Date().getFullYear()} CLOUDSSH`);
    await page.locator('#host').fill('ssh.example.com');
    await page.locator('#username').fill('test-user');
    await page.locator('#auth-tab-key').click();
    if (name === 'id_ed25519_encrypted') {
      await page.getByLabel('选择密钥文件').setInputFiles(join(__dirname, '../ssh/fixtures', name));
      await expect(page.locator('#anon-key-picker [role=status]')).toHaveText(name);
      await expect(page.locator('#private-key')).toHaveValue(fixture(name));
    } else await page.locator('#private-key').fill(fixture(name));
    await page.locator('#remember-me').check();
    await page.locator('#connect-btn').click();
    const input = page.locator('#app-dialog-input');
    await expect(input).toHaveAttribute('type', 'password');
    expect(configs).toHaveLength(0);
    await input.fill(passphrase);
    await input.press('Enter');
    await expect.poll(() => configs.length).toBe(1);
    expect(configs[0]).toMatchObject({ authMethod: 'publickey' });
    expect(JSON.stringify(configs)).not.toContain(passphrase);
    expect(configs[0]).not.toHaveProperty('passphrase');
    expect(configs[0].privateKey).not.toContain('ENCRYPTED PRIVATE KEY');
    await expect(input).toHaveValue('');
    const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('cloudssh_recent_connections')!));
    expect(recent[0]).not.toHaveProperty('encryptedCred');
    expect(JSON.stringify(recent)).not.toContain(passphrase);
  });
}

test('取消解锁不建立连接，并清空密码框', async ({ page }) => {
  await mockAnonymousSession(page);
  let connections = 0;
  await page.routeWebSocket('**/api/ssh*', () => { connections++; });
  await page.goto('/?lang=en-US');
  await page.locator('#host').fill('ssh.example.com');
  await page.locator('#username').fill('test-user');
  await page.locator('#auth-tab-key').click();
  await page.locator('#private-key').fill(fixture('id_ed25519_encrypted'));
  await page.locator('#connect-btn').click();
  await page.locator('#app-dialog-input').fill('cancelled-secret');
  await page.locator('.app-dialog__button--cancel').click();
  await expect(page.locator('#app-dialog-input')).toHaveValue('');
  await expect(page.locator('#connect-btn')).toBeEnabled();
  expect(connections).toBe(0);
});

test('文件读取过大或弹窗已重开时不覆盖当前私钥', async ({ page }) => {
  await page.route('**/api/auth/me', r => r.request().method() === 'GET' ? r.fulfill({ json: {
    id: 1, github_id: 1, username: 'test-user', avatar_url: '',
  } }) : r.fallback());
  await page.route('**/api/servers', r => r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.fallback());
  await page.goto('/?lang=en-US');
  await page.locator('#add-server-btn').click();
  await expect(page.locator('#server-password-hint')).toBeHidden();
  await expect(page.locator('#user-copyright-year').locator('..')).toHaveText(`© ${new Date().getFullYear()} CLOUDSSH`);
  await page.locator('#modal-auth-tab-key').click();
  const key = page.locator('#server-private-key'), file = page.locator('#server-private-key-file');
  await key.fill('original draft');
  await file.setInputFiles({ name: 'too-big', mimeType: 'text/plain', buffer: Buffer.alloc(128 * 1024 + 1) });
  await expect(key).toHaveJSProperty('validationMessage', 'The private key file must not exceed 128 KiB.');
  await expect(key).toHaveValue('original draft');
  await page.evaluate(() => {
    File.prototype.text = () => new Promise<string>(resolve => { (window as any).finishKeyRead = resolve; });
  });
  await file.setInputFiles({ name: 'id_ed25519', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(key).toHaveJSProperty('validationMessage', 'Reading the private key file. Please wait.');
  await page.locator('#modal-close-btn').click();
  await page.locator('#add-server-btn').click();
  await page.locator('#modal-auth-tab-key').click();
  await key.fill('new draft');
  await page.evaluate(() => (window as any).finishKeyRead('old key'));
  await expect(key).toHaveValue('new draft');
  await expect(page.locator('#server-key-picker [role=status]')).toBeEmpty();
});

test('服务器编辑器自动聚焦不会抢走后续字段的输入焦点', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: {
    id: 1, github_id: 1, username: 'test-user', avatar_url: '',
  } }));
  await page.route('**/api/servers', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: [] }) : route.fallback());
  await page.goto('/?lang=en-US');
  await expect(page.locator('#add-server-btn')).toBeVisible();
  await page.clock.install();
  // Open and move focus in the same browser task, before any old 100ms timer can fire.
  await page.evaluate(() => {
    document.getElementById('add-server-btn')!.click();
    document.getElementById('server-username')!.focus();
  });
  await page.clock.runFor(150);
  await expect(page.locator('#server-username')).toBeFocused();
});

test('保存加密私钥需单独同意保存解锁材料，拒绝时不提交', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: {
    id: 1, github_id: 1, username: 'test-user', avatar_url: '',
  } }));
  const saves: Array<Record<string, unknown>> = [];
  await page.route('**/api/servers', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON();
    saves.push(body);
    return route.fulfill({ status: 201, json: { ...body, id: 1, inferred_hint: 'apac' } });
  });
  await page.goto('/?lang=en-US');
  await page.locator('#add-server-btn').click();
  await page.locator('#server-name').fill('Encrypted key');
  await page.locator('#server-host').fill('ssh.example.com');
  await page.locator('#server-username').fill('test-user');
  await page.locator('#modal-auth-tab-key').click();
  const picker = page.getByLabel('Choose key file');
  await picker.setInputFiles(join(__dirname, '../ssh/fixtures/id_ed25519_encrypted'));
  await expect(page.locator('#server-private-key')).toHaveValue(fixture('id_ed25519_encrypted'));
  await expect(page.locator('#server-key-picker [role=status]')).toHaveText('id_ed25519_encrypted');
  expect(saves).toHaveLength(0);
  await page.locator('#server-submit-btn').click();
  await expect(page.locator('#app-dialog-message')).toContainText('not independent KMS');
  await page.locator('.app-dialog__button--cancel').click();
  await expect(page.locator('#server-submit-btn')).toBeEnabled();
  expect(saves).toHaveLength(0);
  await page.locator('#server-submit-btn').click();
  await page.locator('.app-dialog__button--confirm').click();
  const input = page.locator('#app-dialog-input');
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(passphrase);
  await input.press('Enter');
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].auth_method).toBe('publickey');
  expect(saves[0].credential).toContain('BEGIN OPENSSH PRIVATE KEY');
  expect(JSON.stringify(saves)).not.toContain(passphrase);
  await expect(input).toHaveValue('');
  await expect(page.locator('#server-modal')).toBeHidden();
  await expect(page.locator('#server-private-key')).toHaveValue('');
  await expect(page.locator('#server-key-picker [role=status]')).toBeEmpty();

  // A decrypted result arriving after the editor closes must not save into another editor.
  await page.evaluate(() => {
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    (crypto.subtle as any).decrypt = async (...args: any[]) => {
      const result = await (decrypt as any)(...args);
      await new Promise<void>((resolve) => { (window as any).__releaseKeyDecrypt = resolve; });
      return result;
    };
  });
  await page.locator('#add-server-btn').click();
  await page.locator('#server-name').fill('Cancelled pending unlock');
  await page.locator('#server-host').fill('ssh.example.com');
  await page.locator('#server-username').fill('test-user');
  await page.locator('#modal-auth-tab-key').click();
  await page.locator('#server-private-key').fill(fixture('id_ed25519_encrypted'));
  await page.locator('#server-submit-btn').click();
  await page.locator('.app-dialog__button--confirm').click();
  await input.fill(passphrase);
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__releaseKeyDecrypt))).toBe(true);
  await page.locator('#modal-close-btn').click();
  await page.locator('#add-server-btn').click();
  await page.locator('#server-name').fill('Different editor');
  await page.evaluate(async () => {
    (window as any).__releaseKeyDecrypt();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(saves).toHaveLength(1);
  await expect(page.locator('#server-name')).toHaveValue('Different editor');
  await expect(page.locator('#server-submit-btn')).toBeEnabled();
});
