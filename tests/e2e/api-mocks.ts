import type { BrowserContext, Request } from '@playwright/test';
import { E2E_UNMOCKED_API_HEADER, isApiUrl } from '../../frontend/e2e-server';
import { OPTIONAL_THIRD_PARTY_ASSETS } from './helpers';

// Only initialization reads have defaults. Writes and feature-specific APIs must be mocked
// explicitly by their test; a blanket success response would hide missing business coverage.
const DEFAULT_GET_RESPONSES: Record<string, { status: number; json: unknown }> = {
  '/api/config': {
    status: 200,
    json: {
      turnstileEnabled: false,
      sitekey: '',
      githubAuthEnabled: false,
      githubAuthRequired: false,
      authMode: 'anonymous',
    },
  },
  '/api/version': { status: 200, json: { latestVersion: null } },
  '/api/auth/me': { status: 401, json: { error: 'unauthorized' } },
  '/api/user/mobile-shortcuts': { status: 200, json: { shortcuts: null } },
  '/api/user/theme': { status: 200, json: { themes: [], activeId: null, theme: null } },
};

export interface ApiMockGuard {
  readonly unexpectedRequests: readonly string[];
  assertNoUnexpectedRequests(): void;
}

/** Context routes cover every page/popup. Later page.route() handlers override the defaults. */
export async function installApiMocks(context: BrowserContext): Promise<ApiMockGuard> {
  const unexpected = new Set<string>();
  const record = (request: Request): void => {
    unexpected.add(`${request.method()} ${new URL(request.url()).pathname}`);
  };

  // page.route(..., route.continue()) bypasses context handlers. Catch that escape at the
  // E2E server's marked 501 response, rather than allowing a caught fetch error to pass.
  context.on('response', (response) => {
    if (
      isApiUrl(new URL(response.url())) &&
      response.headers()[E2E_UNMOCKED_API_HEADER] === 'true'
    ) {
      record(response.request());
    }
  });

  await context.route(isApiUrl, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const fallback = request.method() === 'GET' ? DEFAULT_GET_RESPONSES[path] : undefined;
    if (fallback) {
      await route.fulfill(fallback);
      return;
    }

    record(request);
    // The test's teardown assertion fails even if application code catches this rejection.
    // A page may close during abort; the recorded violation must still be reported.
    await route.abort('blockedbyclient').catch(() => {});
  });
  await context.route(OPTIONAL_THIRD_PARTY_ASSETS, (route) => route.abort());

  return {
    get unexpectedRequests() {
      return [...unexpected];
    },
    assertNoUnexpectedRequests() {
      if (unexpected.size > 0) {
        throw new Error(
          `Unmocked E2E API requests:\n${[...unexpected].join('\n')}\n` +
          'Declare a method-specific page.route() mock before triggering the request.'
        );
      }
    },
  };
}
