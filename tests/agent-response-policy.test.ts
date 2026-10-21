import { describe, expect, it } from 'vitest';
import { resolveAIModelBudgets } from '../src/ai-model-policy';
import { normalizeResponseDiagnostics, responseErrorDebugMessage } from '../src/agent-response-diagnostics';
import { responseErrorMessage } from '../frontend/src/agent/response-errors';
import { setLocale } from '../frontend/src/i18n';

const requestId = '12345678-1234-4123-8123-123456789abc';
describe('AI model budgets and safe diagnostics', () => {
  it('uses compatible defaults and accepts explicit model limits', () => {
    expect(resolveAIModelBudgets({})).toEqual({ context_window: 64_000, max_output_tokens: 8192 });
    expect(resolveAIModelBudgets({ context_window: null, max_output_tokens: null })).toEqual(resolveAIModelBudgets({}));
    expect(resolveAIModelBudgets({ context_window: 8192, max_output_tokens: 1024 })).toEqual({ context_window: 8192, max_output_tokens: 1024 });
  });
  it.each([
    { context_window: 4096 }, { context_window: '32000' }, { context_window: 1_000_001 },
    { max_output_tokens: 0 }, { max_output_tokens: 128_001 }, { max_output_tokens: 1.5 },
    { context_window: 8192, max_output_tokens: 8192 }, { max_output_tokens: false },
  ])('rejects invalid limits without coercing types: %j', value => {
    expect(() => resolveAIModelBudgets(value)).toThrow();
  });
  it('drops unknown metadata and all free-form provider text', () => {
    expect(normalizeResponseDiagnostics({ purpose: 'memory', stage: 'parse', requestId,
      parameter: 'input', providerCode: 'context_length_exceeded', message: 'SECRET', arbitrary: 'SECRET' }))
      .toEqual({ purpose: 'memory', stage: 'parse', requestId, parameter: 'input', providerCode: 'context_length_exceeded' });
    expect(normalizeResponseDiagnostics({ purpose: 'SECRET', stage: 'SECRET', requestId: 'SECRET',
      parameter: 'SECRET', providerCode: 'SECRET' })).toEqual({});
  });
  it('keeps only known incomplete reasons and bounded integer usage', () => {
    expect(normalizeResponseDiagnostics({ incompleteReason: 'max_output_tokens', requestedOutputTokens: 8192,
      outputTokens: 8000, reasoningTokens: 7900, rawReason: 'SECRET' }))
      .toEqual({ incompleteReason: 'max_output_tokens', requestedOutputTokens: 8192, outputTokens: 8000, reasoningTokens: 7900 });
    for (const value of ['SECRET', '100', -1, NaN, Infinity, 1.5, 1_000_001, {}, []]) {
      expect(normalizeResponseDiagnostics({ incompleteReason: value, requestedOutputTokens: value,
        outputTokens: value, reasoningTokens: value })).toEqual({});
    }
    expect(normalizeResponseDiagnostics({ outputTokens: 0, reasoningTokens: 0 })).toEqual({ outputTokens: 0, reasoningTokens: 0 });
  });
  it.each(['zh-CN', 'zh-TW', 'en-US'] as const)('explains checkpoint pauses without technical diagnostics in %s', locale => {
    setLocale(locale, { persist: false });
    const message = responseErrorMessage('responses_incomplete', undefined, { purpose: 'checkpoint', stage: 'parse',
      requestId, incompleteReason: 'max_output_tokens', requestedOutputTokens: 8192, outputTokens: 8000,
      reasoningTokens: 7900, providerMessage: 'SECRET' });
    expect(message).toContain(locale === 'en-US' ? 'safely paused' : locale === 'zh-TW' ? '安全暫停' : '安全暂停');
    for (const detail of ['8192', '8000', '7900', requestId, 'max_output_tokens']) expect(message).not.toContain(detail);
    expect(message).not.toMatch(/SECRET|agent\./);
  });
  it.each(['zh-CN', 'zh-TW', 'en-US'] as const)('shows only the short HTTP error message in %s', locale => {
    setLocale(locale, { persist: false });
    const message = responseErrorMessage('responses_http', 400, {
      purpose: 'main', stage: 'http', requestId, parameter: 'text.format',
      providerCode: 'unsupported_parameter', message: '<script>SECRET</script>',
    });
    expect(message).toContain('400');
    expect(message).toBe(responseErrorMessage('responses_http', 400));
    for (const detail of ['text.format', 'unsupported_parameter', requestId, '\n']) expect(message).not.toContain(detail);
    if (locale === 'zh-CN') expect(message).toBe('Responses API 请求失败（HTTP 400），请检查密钥、模型和服务商能力。');
    expect(message).not.toMatch(/SECRET|<script>|agent\.error/);
    expect(responseErrorMessage('SECRET', 'SECRET' as any, { requestId: 'SECRET' })).not.toContain('SECRET');
  });
  it('formats only allowlisted diagnostics for the debug terminal', () => {
    const message = responseErrorDebugMessage('responses_http', 400, { purpose: 'memory', stage: 'http',
      parameter: 'text.format', providerCode: 'unsupported_parameter', requestId,
      incompleteReason: 'max_output_tokens', requestedOutputTokens: 8192, outputTokens: 8000,
      reasoningTokens: 7900, message: 'SECRET', api_key: 'SECRET', upstreamRequestId: 'SECRET' });
    expect(message).toBe('Agent Responses failure: ' + JSON.stringify({ code: 'responses_http', status: 400,
      purpose: 'memory', stage: 'http', parameter: 'text.format', providerCode: 'unsupported_parameter',
      incompleteReason: 'max_output_tokens', requestedOutputTokens: 8192, outputTokens: 8000,
      reasoningTokens: 7900, requestId }));
    expect(message).not.toContain('SECRET');
    expect(responseErrorDebugMessage('SECRET', 'SECRET', { requestId: 'SECRET' }))
      .toBe('Agent Responses failure: {"code":"responses_failed"}');
  });
});
