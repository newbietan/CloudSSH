import { installApiMocks } from './api-mocks';
import { expect, test, type Page } from './fixtures';

// Request-guard checks need a same-origin document, not another full CloudSSH boot. Only the
// probe document is stubbed here; /api requests still cross the original context/Vite boundary.
async function openProbe(page: Page) {
  await page.route('**/__api_probe__', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>API probe</title>' })
  );
  await page.goto('/__api_probe__');
}

test('自动 fixture 无需手动 helper 即提供初始化 JSON 响应', async ({ page, context }) => {
  // A second page also inherits the context-level defaults.
  const secondPage = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#connection-form')).toBeVisible();
  await openProbe(secondPage);
  const responses = await secondPage.evaluate(async () => {
    const paths = ['/api/config', '/api/auth/me', '/api/user/theme', '/api/user/mobile-shortcuts'];
    return Promise.all(paths.map(async (path) => {
      const response = await fetch(path);
      return {
        path,
        status: response.status,
        type: response.headers.get('content-type'),
        data: await response.json(),
      };
    }));
  });
  expect(responses.every((response) => response.type?.includes('application/json'))).toBe(true);
  expect(responses.find((response) => response.path === '/api/auth/me')?.status).toBe(401);
  expect(responses.find((response) => response.path === '/api/user/theme')?.data).toEqual({
    themes: [], activeId: null, theme: null,
  });
  expect(responses.find((response) => response.path === '/api/user/mobile-shortcuts')?.data).toEqual({
    shortcuts: null,
  });
});

test('用例的显式路由可覆盖初始化默认值并匹配查询参数', async ({ page }) => {
  await page.route((url) => url.pathname === '/api/user/theme', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { theme: { name: 'Explicit Theme' } } });
  });
  await openProbe(page);
  const payload = await page.evaluate(() =>
    fetch('/api/user/theme?id=preview').then((response) => response.json())
  );
  expect(payload).toEqual({ theme: { name: 'Explicit Theme' } });
});

test('未知 API 即使被应用 catch，守卫仍记录失败且不泄露参数', async ({ browser, baseURL }) => {
  // An isolated context lets this test verify the negative path without intentionally
  // failing its own automatic fixture. Production specs always use the fixture's page.
  const isolated = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const guard = await installApiMocks(isolated);
  try {
    const page = await isolated.newPage();
    await openProbe(page);
    const caught = await page.evaluate(() =>
      fetch('/api/undeclared?token=secret-must-not-be-logged').then(() => false).catch(() => true)
    );
    expect(caught).toBe(true);
    expect(guard.unexpectedRequests).toEqual(['GET /api/undeclared']);
    expect(() => guard.assertNoUnexpectedRequests()).toThrow('Unmocked E2E API requests:');
    expect(() => guard.assertNoUnexpectedRequests()).not.toThrow('secret-must-not-be-logged');
  } finally {
    await isolated.close();
  }
});

test('基础读取 Mock 不放行未声明的 PUT 或带参数 DELETE', async ({ browser, baseURL }) => {
  const isolated = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const guard = await installApiMocks(isolated);
  try {
    const page = await isolated.newPage();
    await openProbe(page);
    const caught = await page.evaluate(async () => {
      const put = await fetch('/api/user/theme', { method: 'PUT', body: '{}' }).catch(() => null);
      const del = await fetch('/api/user/theme?id=not-declared', { method: 'DELETE' }).catch(
        () => null
      );
      return put === null && del === null;
    });
    expect(caught).toBe(true);
    expect(guard.unexpectedRequests).toEqual(['PUT /api/user/theme', 'DELETE /api/user/theme']);
    expect(() => guard.assertNoUnexpectedRequests()).toThrow('PUT /api/user/theme');
  } finally {
    await isolated.close();
  }
});

test('绕过 route 的 API 返回 501 JSON，守卫仍判失败', async ({ browser, baseURL }) => {
  const isolated = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const guard = await installApiMocks(isolated);
  try {
    const page = await isolated.newPage();
    await page.route('**/api/bypass-mock', (route) => route.continue());
    await openProbe(page);
    const response = await page.evaluate(async () => {
      const result = await fetch('/api/bypass-mock');
      return {
        status: result.status,
        type: result.headers.get('content-type'),
        data: await result.json(),
      };
    });
    expect(response).toEqual({
      status: 501,
      type: 'application/json',
      data: { error: 'Unmocked E2E API request', method: 'GET', path: '/api/bypass-mock' },
    });
    await expect.poll(() => guard.unexpectedRequests).toEqual(['GET /api/bypass-mock']);
    expect(() => guard.assertNoUnexpectedRequests()).toThrow('GET /api/bypass-mock');
  } finally {
    await isolated.close();
  }
});
