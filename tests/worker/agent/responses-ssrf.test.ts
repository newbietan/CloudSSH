import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsesClient } from '../../../src/worker/agent/responses-client';
import { aiConfig, responseObject } from './responses-fixtures';

const request = { input: [{ role: 'user' as const, content: 'Inspect' }], instructions: 'Stable', stream: false, max_output_tokens: 8192 };
afterEach(() => vi.restoreAllMocks());

describe('Responses credential boundary uses real SSRF validation', () => {
  it.each(['localhost', '127.0.0.1', '169.254.169.254', '[::1]'])('never fetches a private/metadata literal (%s)', async host => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(new ResponsesClient({ ...aiConfig, base_url: `https://${host}/v1` }).create(request, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_address' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([['192.168.1.2', 1], ['fd00::1', 28]])('blocks domains resolving to private addresses (%s)', async (ip, type) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toContain('cloudflare-dns.com/dns-query');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type, data: ip }] }));
    });
    const host = type === 1 ? 'responses-private-a.example.com' : 'responses-private-aaaa.example.com';
    // Test both main and auxiliary calls: they share the same guarded transport.
    for (const stream of [true, false]) {
      await expect(new ResponsesClient({ ...aiConfig, base_url: `https://${host}/v1` }).create({ ...request, stream }, new AbortController().signal)).rejects.toMatchObject({ code: 'responses_address' });
    }
    expect(fetch).toHaveBeenCalledTimes(2); // A + AAAA only; cached validation never forwards a key.
  });

  it('sends the key only to a validated public destination with redirect forwarding disabled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(responseObject('resp_1'))));
    await new ResponsesClient({ ...aiConfig, base_url: 'https://8.8.8.8/v1' }).create(request, new AbortController().signal);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://8.8.8.8/v1/responses', expect.objectContaining({ redirect: 'manual', headers: expect.objectContaining({ Authorization: `Bearer ${aiConfig.api_key}` }) }));
  });
});
