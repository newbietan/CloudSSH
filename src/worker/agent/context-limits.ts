// Serialized UTF-8 budgets, not estimates of JavaScript heap size.
export const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
export const MAX_RETAINED_BYTES = 3 * 1024 * 1024;
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const MAX_EVIDENCE_BYTES = 96 * 1024;
const encoder = new TextEncoder();

export function bytes(value: unknown): number {
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

export function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const side = Math.max(0, Math.floor((limit - 64) / 2));
  return `${text.slice(0, side)}\n[... bounded observation: middle omitted ...]\n${text.slice(-side)}`;
}

export function boundedUtf8(text: string, limit: number): string {
  if (bytes(text) <= limit) return text;
  let low = 0;
  let high = Math.min(text.length, limit);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(boundedText(text, mid)) <= limit) low = mid; else high = mid - 1;
  }
  return boundedText(text, low);
}

export function boundedToolOutput(output: string, limit = MAX_TOOL_RESULT_BYTES - 512): string {
  // Account for escaping a JSON tool result inside another JSON string.
  if (bytes(JSON.stringify(output)) <= limit) return output;
  const metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(output);
    for (const key of ['status', 'executed', 'exit_code', 'blocked', 'user_rejected']) {
      if (['string', 'number', 'boolean'].includes(typeof parsed?.[key])) metadata[key] = parsed[key];
    }
  } catch { /* Non-JSON tool data is still bounded. */ }
  let view = Math.floor(limit / 2);
  for (;;) {
    const result = JSON.stringify({ ...metadata, truncated: true,
      result: boundedUtf8(output, view), instruction: 'Middle output omitted; inspect state before retrying unknown operations.' });
    if (bytes(JSON.stringify(result)) <= limit) return result;
    view = Math.floor(view / 2);
  }
}
