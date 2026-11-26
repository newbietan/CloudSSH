import { test as base } from '@playwright/test';
import { installApiMocks } from './api-mocks';

export { expect } from '@playwright/test';
export type { Locator, Page } from '@playwright/test';

export const test = base.extend<{ apiIsolation: void }>({
  apiIsolation: [
    async ({ context }, use, testInfo) => {
      const guard = await installApiMocks(context);
      try {
        await use();
      } finally {
        // Close pages/popups before checking, so late requests cannot escape teardown checks.
        // Context closure also lets Playwright flush its tracing/artifact listeners.
        await context.close();
        if (guard.unexpectedRequests.length > 0) {
          await testInfo.attach('unmocked-api-requests', {
            body: JSON.stringify(guard.unexpectedRequests, null, 2),
            contentType: 'application/json',
          });
        }
        guard.assertNoUnexpectedRequests();
      }
    },
    { auto: true },
  ],
});
