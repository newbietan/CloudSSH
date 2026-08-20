import { expect, type Page, test } from '@playwright/test';
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
