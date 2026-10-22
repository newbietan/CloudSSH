import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit-mobile',
      testMatch: [
        /(?:api-isolation|auth-challenge|none-auth|connection-recovery|ios-ime|sftp-panel-actions|version-notice)\.spec\.ts/,
        /terminal-(?:touch-scroll|focus-report)\.spec\.ts/,
      ],
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: {
    command: 'pnpm --dir frontend exec vite --mode e2e --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    env: {
      E2E_TEST: 'true',
    },
    // Never reuse a normal dev server without E2E isolation or silently switch ports.
    reuseExistingServer: false,
    timeout: 120_000,
  },
  outputDir: 'test-results',
});
