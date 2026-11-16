import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { authenticateMcp } from '../../src/worker/mcp-auth';

const token = `mcp_42:${'a'.repeat(64)}`;
const accessToken = `mcp_cf-${'b'.repeat(32)}:${'c'.repeat(64)}`;
const secret = 'PRIVATE-ACCESS-SECRET';
const request = (value = token) => new Request('https://cloudssh.test/mcp', {
  headers: {
    Authorization: `Bearer ${value}`,
    'CF-Access-Client-Id': 'PRIVATE-CLIENT-ID',
    'CF-Access-Client-Secret': secret,
    'Cf-Access-Authenticated-User-Email': 'private-owner@example.com',
  },
});
function env(status = 401, overrides: Partial<Env> = {}) {
  const fetch = vi.fn(async () => Response.json({ error: secret }, { status }));
  return {
    value: {
      GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret',
      USER_DB: { idFromName: (value: string) => value, get: () => ({ fetch }) },
      ...overrides,
    } as unknown as Env,
    fetch,
  };
}
afterEach(() => vi.restoreAllMocks());

describe('bounded secret-free MCP authentication diagnostics', () => {
  it.each([undefined, 'false'])('keeps diagnostics off without explicit DEBUG_MODE=true (%s)', async DEBUG_MODE => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = env(401, { DEBUG_MODE });
    expect(await authenticateMcp(request('PRIVATE-INVALID-TOKEN'), fixture.value)).toBeNull();
    expect(await authenticateMcp(request(), fixture.value)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('reports only fixed stages, distinguishing native admission and credential lookup failures', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = env(401, { DEBUG_MODE: 'true' });
    await authenticateMcp(request('PRIVATE-INVALID-TOKEN'), fixture.value);
    await authenticateMcp(request(accessToken), { ...fixture.value, CF_ACCESS: 'true' });
    await authenticateMcp(request(), { ...fixture.value, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined });
    await authenticateMcp(request(), { ...fixture.value, ADMIN_PASSWORD_HASH: 'PRIVATE-INVALID-HASH' });
    await authenticateMcp(request(accessToken), fixture.value);
    await authenticateMcp(request(), { ...fixture.value, GITHUB_ALLOWED_USER_IDS: '43' });
    await authenticateMcp(request(), fixture.value);
    for (const status of [500, 404]) await authenticateMcp(request(), env(status, { DEBUG_MODE: 'true' }).value);
    expect(log.mock.calls).toEqual([
      ['mcp.auth.denied', { reason: 'invalid_bearer' }],
      ['mcp.auth.denied', { reason: 'access_context_missing' }],
      ['mcp.auth.denied', { reason: 'auth_mode_unavailable' }],
      ['mcp.auth.denied', { reason: 'auth_mode_unavailable' }],
      ['mcp.auth.denied', { reason: 'account_mode_mismatch' }],
      ['mcp.auth.denied', { reason: 'account_mode_mismatch' }],
      ['mcp.auth.denied', { reason: 'credential_rejected' }],
      ['mcp.auth.denied', { reason: 'credential_lookup_failed' }],
      ['mcp.auth.denied', { reason: 'credential_lookup_failed' }],
    ]);
    const output = JSON.stringify(log.mock.calls);
    for (const privateValue of [token, accessToken, secret, 'PRIVATE-CLIENT-ID', 'private-owner@example.com', 'PRIVATE-INVALID-TOKEN', 'PRIVATE-INVALID-HASH']) {
      expect(output).not.toContain(privateValue);
    }
  });

  it('bounds logs per isolate, renews the minute window and handles clock rollback', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = env(401, { DEBUG_MODE: 'true' });
    for (let i = 0; i < 25; i++) await authenticateMcp(request('bad'), fixture.value);
    expect(log).toHaveBeenCalledTimes(20);
    expect(fixture.fetch).not.toHaveBeenCalled();
    clock.mockReturnValue(2_060_000);
    await authenticateMcp(request('bad'), fixture.value);
    expect(log).toHaveBeenCalledTimes(21);
    clock.mockReturnValue(1_000);
    await authenticateMcp(request('bad'), fixture.value);
    expect(log).toHaveBeenCalledTimes(22);
  });

  it('does not misclassify the existing request budget response as invalid credentials', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await authenticateMcp(request(), env(429, { DEBUG_MODE: 'true' }).value);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
    expect((result as Response).headers.get('Retry-After')).toBe('60');
    expect(await (result as Response).json()).toEqual({ error: 'rate_limited' });
    expect(log).not.toHaveBeenCalled();
  });
});
