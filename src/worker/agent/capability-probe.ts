import type { AIProbeReason, AIProbeResult } from '../../ai-capability';
import { resolveAIModelBudgets } from '../../ai-model-policy';
import { ResponsesClient, ResponsesError } from './responses-client';
import type { AIConfig, ResponseInput } from './types';

export const AI_PROBE_DEADLINE_MS = 60_000;

function failureResult(error: unknown, step: AIProbeResult['step']): AIProbeResult {
  const failure = error instanceof ResponsesError ? error : undefined;
  const status = failure?.status;
  const code = failure?.diagnostics.providerCode;
  let reason: AIProbeReason = 'network';
  if (status === 401 || status === 403 || ['invalid_api_key', 'authentication_error', 'permission_denied'].includes(code ?? '')) reason = 'authentication';
  else if (code === 'insufficient_quota' || status === 402) reason = 'quota';
  else if (code === 'rate_limit_exceeded' || status === 429) reason = 'rate_limit';
  else if (code === 'model_not_found') reason = 'model';
  else if ([400, 404, 405, 422, 501].includes(status ?? 0) && code === 'unsupported_model') reason = 'unsupported_model';
  else if ([400, 404, 405, 422, 501].includes(status ?? 0) && code === 'unsupported_feature') reason = 'unsupported_feature';
  else if (code === 'content_policy_violation' || failure?.diagnostics.incompleteReason === 'content_filter') reason = 'policy';
  else if (status != null && status >= 500 && status !== 501) reason = 'temporary';
  else if ([404, 405, 501].includes(status ?? 0)) reason = 'endpoint';
  else if (status === 400 || status === 422) reason = 'request';
  else if (failure?.code === 'responses_address') reason = 'address';
  else if (failure?.code === 'responses_redirect') reason = 'redirect';
  else if (failure?.code === 'responses_timeout') reason = 'timeout';
  else if (failure?.code === 'responses_budget' || failure?.code === 'responses_limits' ||
    failure?.diagnostics.incompleteReason === 'max_output_tokens') reason = 'budget';
  else if (failure && (failure.code !== 'responses_failed' || failure.diagnostics.stage !== 'http')) reason = 'protocol';
  return { verdict: reason === 'unsupported_feature' || reason === 'unsupported_model' ? 'unsupported' : 'inconclusive',
    reason, step, checkedAt: Date.now() };
}

/** Explicitly billed synthetic round trip only. Never access SSH, saved servers or long-term memory.
 * A successful result confirms this request pair, NOT every tool/model capability or future availability.
 */
export async function probeNativeCompaction(config: AIConfig, parent?: AbortSignal): Promise<AIProbeResult> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort('probe_timeout'), AI_PROBE_DEADLINE_MS);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  let step: AIProbeResult['step'] = 'compact';
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ResponsesError('responses_timeout'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([cancelled, (async (): Promise<AIProbeResult> => {
      let budgets: ReturnType<typeof resolveAIModelBudgets>;
      try { budgets = resolveAIModelBudgets(config); }
      catch { throw new ResponsesError('responses_limits'); }
      const client = new ResponsesClient(config);
      const token = `PROBE-${crypto.randomUUID()}`;
      const instructions = 'This is a synthetic compatibility test, not an SSH task. Preserve the verification token. When asked, reply with the exact token only, without Markdown or explanations. Do not call tools.';
      const input: ResponseInput[] = [
        { role: 'user', content: 'Remember the verification token in the following assistant message for the next turn.' },
        { type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `Verification token: ${token}`, annotations: [] }] },
      ];
      const compacted = await client.compact(input, instructions, signal);
      signal.throwIfAborted();
      step = 'continuation';
      const response = await client.create({ purpose: 'main', stream: false, instructions,
        input: [...compacted.output, { role: 'user', content: 'Return only the preceding verification token beginning with PROBE-.' }],
        max_output_tokens: Math.min(1024, budgets.max_output_tokens), reasoning: { effort: 'low' } }, signal);
      signal.throwIfAborted();
      const passed = response.text.trim() === token && response.calls.length === 0;
      return { verdict: passed ? 'supported' : 'inconclusive', reason: passed ? 'verified' : 'mismatch',
        step, checkedAt: Date.now() };
    })()]);
  } catch (error) {
    return failureResult(signal.aborted ? new ResponsesError('responses_timeout') : error, step);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
