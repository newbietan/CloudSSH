// Safe public contract for an explicitly paid, form-scoped native compaction round-trip test.
// Never include keys, provider response text, encrypted items, URLs, model names or upstream headers.
export const AI_PROBE_REASONS = [
  'verified', 'unsupported_feature', 'unsupported_model', 'authentication', 'model', 'endpoint',
  'request', 'rate_limit', 'quota', 'temporary', 'timeout', 'protocol', 'budget', 'address',
  'redirect', 'mismatch', 'network', 'policy',
] as const;
export type AIProbeReason = typeof AI_PROBE_REASONS[number];
export interface AIProbeResult {
  verdict: 'supported' | 'unsupported' | 'inconclusive';
  reason: AIProbeReason;
  step: 'compact' | 'continuation';
  checkedAt: number;
}

/** Browser validates this boundary as well; an HTTP response is not permission to render metadata. */
export function normalizeAIProbeResult(value: unknown): AIProbeResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reason = AI_PROBE_REASONS.find(item => item === raw.reason);
  if (!reason || !['supported', 'unsupported', 'inconclusive'].includes(String(raw.verdict)) ||
    !['compact', 'continuation'].includes(String(raw.step)) ||
    typeof raw.checkedAt !== 'number' || !Number.isSafeInteger(raw.checkedAt) || raw.checkedAt < 0) return null;
  if ((raw.verdict === 'supported') !== (reason === 'verified') ||
    (raw.verdict === 'unsupported') !== ['unsupported_feature', 'unsupported_model'].includes(reason) ||
    (raw.verdict === 'supported' && raw.step !== 'continuation')) return null;
  return { verdict: raw.verdict as AIProbeResult['verdict'], reason,
    step: raw.step as AIProbeResult['step'], checkedAt: raw.checkedAt };
}
