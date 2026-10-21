import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeNativeCompaction, AI_PROBE_DEADLINE_MS } from '../../../src/worker/agent/capability-probe';
import { normalizeAIProbeResult } from '../../../src/ai-capability';
import { aiConfig, compactReply, compactedWindow, responseObject } from './responses-fixtures';

vi.mock('../../../src/worker/agent/ssrf', () => ({ validateBaseUrlWithDNS: async () => ({ valid: true }) }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Synthetic native compaction round trip', () => {
  it('replays the entire compact window and checks a random token without tools or real server data', async () => {
    const requests: any[] = [];
    let token = '';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      expect(init!.redirect).toBe('manual');
      if (String(url).endsWith('/compact')) {
        token = body.input[1].content[0].text.replace('Verification token: ', '');
        expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model']);
        return compactReply([...compactedWindow, body.input[1]]);
      }
      expect(body.input.slice(0, 2)).toEqual(compactedWindow);
      expect(body.input[2]).toEqual(requests[0].input[1]);
      expect(body.input.at(-1).content).not.toContain(token);
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('previous_response_id');
      expect(body.max_output_tokens).toBe(256);
      return Response.json(responseObject('verified', token));
    });
    const result = await probeNativeCompaction({ ...aiConfig, max_output_tokens: 256 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ verdict: 'supported', reason: 'verified', step: 'continuation' });
    expect(normalizeAIProbeResult(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/PROBE-|test-key|OPAQUE_COMPACTION/);
  });

  it.each([
    [400, 'invalid_request_error', 'inconclusive', 'request'],
    [404, undefined, 'inconclusive', 'endpoint'],
    [405, undefined, 'inconclusive', 'endpoint'],
    [501, undefined, 'inconclusive', 'endpoint'],
    [404, 'model_not_found', 'inconclusive', 'model'],
    [401, 'invalid_api_key', 'inconclusive', 'authentication'],
    [403, 'permission_denied', 'inconclusive', 'authentication'],
    [400, 'insufficient_quota', 'inconclusive', 'quota'],
    [400, 'content_policy_violation', 'inconclusive', 'policy'],
    [400, 'unsupported_model', 'unsupported', 'unsupported_model'],
    [422, 'unsupported_feature', 'unsupported', 'unsupported_feature'],
  ])('does not overclaim capability from HTTP %s/%s', async (status, code, verdict, reason) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ error: { code, message: 'SECRET_PROVIDER_BODY api_key=test-key' } }, { status: status as number }));
    const result = await probeNativeCompaction(aiConfig);
    expect(result).toMatchObject({ verdict, reason, step: 'compact' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|test-key/);
  });

  it.each([[429, 'rate_limit'], [503, 'temporary']] as const)('bounds transient HTTP %s and leaves ability unconfirmed', async (status, reason) => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status }));
    const pending = probeNativeCompaction(aiConfig);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result).toMatchObject({ verdict: 'inconclusive', reason });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not call continuation after a malformed compact response, even if HTTP 200', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ output: 'SECRET' }));
    expect(await probeNativeCompaction(aiConfig)).toMatchObject({ verdict: 'inconclusive', reason: 'protocol', step: 'compact' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats an incorrect continuation as inconclusive, not proof that compact is unsupported', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(compactReply()).mockResolvedValueOnce(Response.json(responseObject('wrong', 'SECRET_OTHER_ANSWER')));
    const result = await probeNativeCompaction(aiConfig);
    expect(result).toMatchObject({ verdict: 'inconclusive', reason: 'mismatch', step: 'continuation' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('checks the continuation contract instead of assuming the first request proved compatibility', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(compactReply()).mockResolvedValueOnce(Response.json({ error: { code: 'invalid_request_error' } }, { status: 400 }));
    expect(await probeNativeCompaction(aiConfig)).toMatchObject({ verdict: 'inconclusive', reason: 'request', step: 'continuation' });
  });

  it.each([false, true])('bounds a stalled request and does not continue after cancellation (parent=%s)', async parent => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = probeNativeCompaction(aiConfig, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    if (parent) controller.abort(); else await vi.advanceTimersByTimeAsync(AI_PROBE_DEADLINE_MS);
    expect(await pending).toMatchObject({ verdict: 'inconclusive', reason: 'timeout' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects unsafe result metadata and inconsistent capability claims in the browser contract', () => {
    expect(normalizeAIProbeResult({ verdict: 'supported', reason: 'endpoint', step: 'compact', checkedAt: 1 })).toBeNull();
    expect(normalizeAIProbeResult({ verdict: 'unsupported', reason: 'authentication', step: 'compact', checkedAt: 1 })).toBeNull();
    expect(normalizeAIProbeResult({ verdict: 'supported', reason: 'verified', step: 'continuation', checkedAt: 1,
      providerBody: 'SECRET', api_key: 'SECRET' })).toEqual({ verdict: 'supported', reason: 'verified', step: 'continuation', checkedAt: 1 });
  });
});
