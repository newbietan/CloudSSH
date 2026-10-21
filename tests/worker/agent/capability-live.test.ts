import { describe, expect, it } from 'vitest';
import { probeNativeCompaction } from '../../../src/worker/agent/capability-probe';
import { validatedCompactionWindow } from '../../../src/worker/agent/compaction-window';
import { ResponsesClient } from '../../../src/worker/agent/responses-client';

const apiKey = process.env.CLOUDSSH_LIVE_AI_KEY || process.env.OPENAI_API_KEY;
const baseUrl = process.env.CLOUDSSH_LIVE_AI_BASE_URL || 'https://api.openai.com/v1';
const model = process.env.CLOUDSSH_LIVE_AI_MODEL || 'gpt-4o-mini';
const isEnabled = process.env.CLOUDSSH_LIVE_AI_TEST === '1' && Boolean(apiKey);

describe.runIf(isEnabled)('Live provider native compaction interoperability', () => {
  it('verifies /responses/compact and continuation with synthetic tokens against a real provider', async () => {
    const config = { base_url: baseUrl, api_key: apiKey!, model, context_window: 64_000, max_output_tokens: 1024 };
    const result = await probeNativeCompaction(config);
    expect(result.checkedAt).toBeGreaterThan(0);
    expect(['supported', 'unsupported', 'inconclusive']).toContain(result.verdict);
    expect(result.step).toBeDefined();
    if (result.verdict === 'supported') {
      expect(result.reason).toBe('verified');
      expect(result.step).toBe('continuation');
    }
  }, 90_000);

  it('ensures live compacted output matches validatedCompactionWindow contract without pruning', async () => {
    const client = new ResponsesClient({ base_url: baseUrl, api_key: apiKey!, model,
      context_window: 64_000, max_output_tokens: 1024 });
    const token = `LIVE-TOKEN-${Date.now()}`;
    const input = [
      { role: 'user' as const, content: 'Remember the token: ' + token },
      { type: 'message' as const, role: 'assistant' as const, status: 'completed' as const,
        content: [{ type: 'output_text' as const, text: `Token stored: ${token}`, annotations: [] }] },
    ];
    const instructions = 'Synthetic test only; do not run commands. Keep the token.';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('test_timeout'), 60_000);
    try {
      const compacted = await client.compact(input, instructions, controller.signal);
      expect(compacted.id).toBeTruthy();
      expect(compacted.output.length).toBeGreaterThan(0);
      const valid = validatedCompactionWindow(compacted.output);
      expect(valid).not.toBeNull();
      expect(valid!.some(item => 'type' in item && item.type === 'compaction')).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  }, 90_000);
});
