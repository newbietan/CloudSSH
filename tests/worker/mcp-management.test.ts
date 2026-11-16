import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { getAuthenticatedUser } from '../../src/worker/auth';
import { handleMcpManagement } from '../../src/worker/mcp';
vi.mock('../../src/worker/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/auth')>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => ({ id: 7, github_id: 42, username: 'owner', avatar_url: null })) };
});
afterEach(() => vi.clearAllMocks());
function fixture() {
  const calls: any[] = [];
  const info = { configured: true, id: 'id', grants: [{ serverId: 1, scopes: ['read'] }], hasAccessCredentials: false, legacy: false };
  const internal = vi.fn(async (request: Request) => {
    const body = await request.json(); calls.push(body);
    return Response.json((body as any).action === 'credentials' ? { token: 'saved-private-token' } : info);
  });
  const invalidate = vi.fn(async () => Response.json({ success: true }));
  const env = { GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test',
    USER_DB: { idFromName: (v: string) => v, get: () => ({ fetch: internal }) },
    MCP_EXECUTION: { idFromName: (v: string) => v, get: () => ({ fetch: invalidate }) },
  } as unknown as Env;
  const call = (path: string, method = 'GET', body?: unknown) => handleMcpManagement(new Request(`https://cloudssh.test${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  return { call, calls, internal, invalidate };
}
describe('singleton MCP owner-only management API', () => {
  it('GET returns metadata only and plaintext export is a separate authenticated POST', async () => {
    const f = fixture();
    expect(await (await f.call('/api/mcp/config?userId=8')).json()).not.toHaveProperty('token');
    expect(f.calls[0]).toMatchObject({ action: 'settings', userId: 7, routeKey: '42' });
    expect((await f.call('/api/mcp/config/credentials')).status).toBe(404);
    expect(await (await f.call('/api/mcp/config/credentials', 'POST')).json()).toEqual({ token: 'saved-private-token' });
    expect(f.calls.at(-1)).toMatchObject({ action: 'credentials', userId: 7 });
  });
  it('permission changes are saved and invalidate only the authenticated owner pool', async () => {
    const f = fixture();
    expect((await f.call('/api/mcp/config', 'PUT', { grants: [] })).ok).toBe(true);
    expect(f.calls[0]).toMatchObject({ action: 'update', userId: 7, input: { grants: [] } });
    expect(f.invalidate).toHaveBeenCalledOnce();
  });
  it('has no revocation or old multi-token endpoints', async () => {
    const f = fixture();
    for (const [path, method] of [['/api/mcp/config', 'DELETE'], ['/api/mcp/tokens', 'POST'], ['/api/mcp/tokens/id', 'DELETE']])
      expect((await f.call(path, method)).status).toBe(404);
    expect(f.internal).not.toHaveBeenCalled(); expect(f.invalidate).not.toHaveBeenCalled();
  });
  it('unauthenticated callers cannot read or export configuration', async () => {
    const f = fixture(); vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(null);
    expect((await f.call('/api/mcp/config/credentials', 'POST')).status).toBe(401);
    expect(f.internal).not.toHaveBeenCalled();
  });
});
