import { holdAnimationFrames } from './browser-timing';
import { expect, type Page, test } from './fixtures';
import { mockAnonymousSession } from './helpers';

interface BrowserChallengeState {
  shown: string[];
  submissions: unknown[];
  cancelled: string[];
}

async function showChallenge(
  page: Page,
  prompts: Array<{ text: string; echo: boolean }>,
  canUseStoredPassword = false
): Promise<void> {
  await page.evaluate(
    async ({ prompts: challengePrompts, canUseStoredPassword: canUseStored }) => {
      const modulePath = '/src/auth-challenge-dialog.ts';
      const { AuthChallengeDialog } = await import(modulePath);
      const state: BrowserChallengeState = { shown: [], submissions: [], cancelled: [] };
      (window as any).__authChallengeState = state;
      (window as any).__authChallengeDialog = new AuthChallengeDialog();
      (window as any).__authChallengeDialog.show(
        {
          type: 'auth_challenge',
          id: 'serv00-round-1',
          name: 'Interactive authentication',
          instruction: 'Complete the requested fields',
          prompts: challengePrompts,
          canUseStoredPassword: canUseStored,
        },
        {
          host: 's15.serv00.com',
          port: 22,
          onShown: (id: string) => state.shown.push(id),
          onSubmit: (submission: unknown) => state.submissions.push(submission),
          onCancel: (id: string) => state.cancelled.push(id),
        }
      );
    },
    { prompts, canUseStoredPassword }
  );
}

test.beforeEach(async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/');
});

test('匿名 password 空密码可连接、重连并从历史恢复', async ({ page }) => {
  const configs: Array<Record<string, unknown>> = [];
  const disconnect: Array<() => void> = [];
  await page.route('**/api/known-hosts?**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
  });
  await page.routeWebSocket('**/api/ssh*', (socket) => {
    disconnect.push(() => socket.close({ code: 1011 }));
    socket.onMessage((data) => {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.host) {
        configs.push(message);
        socket.send(JSON.stringify({ type: 'status', event: 'auth_success', message: '' }));
        socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: '' }));
      } else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', id: message.id }));
      }
    });
  });
  await page.goto('/?lang=zh-CN');
  await page.locator('#host').fill('ssh.example.com');
  await page.locator('#username').fill('alice');
  await page.locator('#auth-tab-key').click();
  await page.locator('#private-key').fill('must-not-send-key');
  await page.locator('#auth-tab-password').click();
  await expect(page.locator('#password')).toHaveValue('');
  await page.locator('#connect-btn').click();
  await expect(page.locator('#term-status')).toContainText('已连接');
  expect(configs[0]).toMatchObject({ authMethod: 'password', password: '' });
  expect(configs[0]).not.toHaveProperty('privateKey');
  disconnect[0]();
  await expect.poll(() => configs.length, { timeout: 10_000 }).toBe(2);
  expect(configs[1]).toMatchObject({ authMethod: 'password', password: '' });
  await page.reload();
  await expect(page.locator('#auth-tab-password')).toHaveClass(/auth-tab-active/);
  await expect(page.locator('#username')).toHaveValue('alice');
  await expect(page.locator('#password')).toHaveValue('');
});

test('空密码连接可进入交互认证，单个空响应及零提示轮次均可直接回车', async ({ page }) => {
  const configs: Array<Record<string, unknown>> = [];
  const acks: string[] = [];
  const responses: Array<{ id: string; responses: string[] }> = [];
  await page.route('**/api/known-hosts?**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
  });
  await page.routeWebSocket('**/api/ssh*', (socket) => {
    const challenge = (id: string, prompts: Array<{ text: string; echo: boolean }>) =>
      socket.send(JSON.stringify({ type: 'auth_challenge', id, name: 'Interactive',
        instruction: '', prompts, canUseStoredPassword: false }));
    socket.onMessage((data) => {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.host) {
        configs.push(message);
        challenge('empty-response', [{ text: 'Password:', echo: false }]);
      } else if (message.type === 'auth_challenge_ack') {
        acks.push(message.id);
      } else if (message.type === 'auth_response') {
        responses.push(message);
        if (message.id === 'empty-response') challenge('zero-prompts', []);
        else {
          socket.send(JSON.stringify({ type: 'status', event: 'auth_success', message: '' }));
          socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: '' }));
        }
      }
    });
  });
  await page.goto('/?lang=zh-CN');
  await page.locator('#host').fill('ssh.example.com');
  await page.locator('#username').fill('alice');
  await page.locator('#connect-btn').click();
  const input = page.locator('.auth-challenge-dialog__input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await expect(page.locator('.auth-challenge-dialog__button--stored')).toHaveCount(0);
  expect(configs[0]).toMatchObject({ authMethod: 'password', password: '' });
  expect(responses).toHaveLength(0);
  await input.press('Enter');
  await expect.poll(() => responses.length).toBe(1);
  expect(responses[0]).toMatchObject({ id: 'empty-response', responses: [''] });
  await expect(input).toHaveCount(0);
  const submit = page.locator('.auth-challenge-dialog__button--submit');
  await expect(submit).toBeFocused();
  await submit.press('Enter');
  await expect.poll(() => responses.length).toBe(2);
  expect(responses[1]).toMatchObject({ id: 'zero-prompts', responses: [] });
  expect(acks).toEqual(['empty-response', 'zero-prompts']);
  await expect(page.locator('.auth-challenge-dialog')).toHaveCount(0);
  await expect(page.locator('#term-status')).toContainText('已连接');
});

for (const [locale, hint] of [
  ['zh-CN', '服务器还要求密码'], ['zh-TW', '伺服器還要求密碼'],
  ['en-US', 'also requires a password'],
]) {
  test(`公钥后 password 第二因素显式提交且不持久化 (${locale})`, async ({ page }) => {
    const responses: Array<{ id: string; responses: string[] }> = [];
    const acks: string[] = [];
    await page.route('**/api/known-hosts?**', (route) => route.request().method() === 'GET'
      ? route.fulfill({ status: 401, json: { error: 'unauthorized' } }) : route.fallback());
    await page.routeWebSocket('**/api/ssh*', (socket) => {
      socket.onMessage((data) => {
        if (typeof data !== 'string') return;
        const message = JSON.parse(data);
        if (message.host) {
          expect(message.authMethod).toBe('publickey');
          expect(message).not.toHaveProperty('password');
          socket.send(JSON.stringify({ type: 'auth_challenge', id: 'password-factor', method: 'password',
            name: '', instruction: '', prompts: [{ text: '', echo: false }], canUseStoredPassword: false }));
        } else if (message.type === 'auth_challenge_ack') acks.push(message.id);
        else if (message.type === 'auth_response') {
          responses.push(message);
          socket.send(JSON.stringify({ type: 'status', event: 'auth_success', message: '' }));
          socket.send(JSON.stringify({ type: 'status', event: 'shell_ready', message: '' }));
        }
      });
    });
    await page.goto(`/?lang=${locale}`);
    await page.locator('#host').fill('ssh.example.com');
    await page.locator('#username').fill('test-user');
    await page.locator('#auth-tab-key').click();
    await page.locator('#private-key').fill('test-key');
    await page.locator('#connect-btn').click();
    await expect(page.locator('.auth-challenge-dialog__instruction')).toContainText(hint);
    await expect.poll(() => acks).toEqual(['password-factor']);
    expect(responses).toHaveLength(0);
    await expect(page.locator('.auth-challenge-dialog__button--stored')).toHaveCount(0);
    const input = page.locator('.auth-challenge-dialog__input');
    await input.fill('transient-factor-secret');
    await input.press('Enter');
    await expect.poll(() => responses.length).toBe(1);
    expect(responses[0]).toMatchObject({ id: 'password-factor', responses: ['transient-factor-secret'] });
    await expect(page.locator('.auth-challenge-dialog')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('transient-factor-secret');
  });
}

test('renders a Serv00 password challenge and acknowledges it only after display', async ({
  page,
}) => {
  await showChallenge(
    page,
    [{ text: '(alice@s15.serv00.com) Password for alice@s15.serv00.com:', echo: false }],
    true
  );

  const dialog = page.locator('.auth-challenge-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('open', '');
  await expect(dialog.locator('.auth-challenge-dialog__target')).toContainText('s15.serv00.com:22');
  await expect(dialog.locator('.auth-challenge-dialog__input')).toHaveAttribute('type', 'password');
  await expect(dialog.locator('.auth-challenge-dialog__button--stored')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__authChallengeState.shown)).toEqual([
    'serv00-round-1',
  ]);

  await dialog.locator('.auth-challenge-dialog__button--stored').click();
  expect(await page.evaluate(() => (window as any).__authChallengeState.submissions)).toEqual([
    {
      type: 'auth_response',
      id: 'serv00-round-1',
      useStoredPassword: true,
    },
  ]);
  await expect(dialog).toHaveCount(0);
});

test('延迟的初始聚焦不抢占已选中的验证码字段', async ({ page }) => {
  const releaseFrame = await holdAnimationFrames(page);
  await showChallenge(page, [
    { text: 'Password:', echo: false },
    { text: 'Verification code:', echo: false },
  ]);
  const dialog = page.locator('.auth-challenge-dialog');
  const inputs = dialog.locator('.auth-challenge-dialog__input');
  await expect(inputs.nth(0)).toBeFocused();
  await inputs.nth(0).fill('account-password');
  await inputs.nth(1).focus();
  await releaseFrame();
  await expect(inputs.nth(1)).toBeFocused();
  // Type through the current focus, rather than fill() refocusing and masking a stolen focus.
  await page.keyboard.type('123456');
  await expect(inputs.nth(0)).toHaveValue('account-password');
  await expect(inputs.nth(1)).toHaveValue('123456');
  await dialog.locator('.auth-challenge-dialog__button--submit').click();
  expect(await page.evaluate(() => (window as any).__authChallengeState.submissions)).toEqual([
    { type: 'auth_response', id: 'serv00-round-1', responses: ['account-password', '123456'] },
  ]);
});

test('零提示认证优先聚焦继续，迟到帧不抢取消按钮', async ({ page }) => {
  const releaseFrame = await holdAnimationFrames(page);
  await showChallenge(page, []);
  const dialog = page.locator('.auth-challenge-dialog');
  await expect(dialog.locator('.auth-challenge-dialog__button--submit')).toBeFocused();
  const cancel = dialog.locator('.auth-challenge-dialog__button--cancel');
  await cancel.focus();
  await releaseFrame();
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(() => (window as any).__authChallengeState.submissions)).toEqual([]);
  await cancel.press('Enter');
  expect(await page.evaluate(() => (window as any).__authChallengeState.cancelled)).toEqual([
    'serv00-round-1',
  ]);
});

test('keeps a multi-prompt password and TOTP challenge usable in a mobile viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await showChallenge(page, [
    { text: 'Password:', echo: false },
    { text: 'Verification code:', echo: false },
  ]);

  const dialog = page.locator('.auth-challenge-dialog');
  const inputs = dialog.locator('.auth-challenge-dialog__input');
  await expect(dialog).toBeVisible();
  await expect(inputs).toHaveCount(2);
  await inputs.nth(0).fill('account-password');
  await inputs.nth(1).fill('123456');
  await dialog.locator('.auth-challenge-dialog__button--submit').click();

  expect(await page.evaluate(() => (window as any).__authChallengeState.submissions)).toEqual([
    {
      type: 'auth_response',
      id: 'serv00-round-1',
      responses: ['account-password', '123456'],
    },
  ]);
});
