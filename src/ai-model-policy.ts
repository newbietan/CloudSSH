// Shared browser/Worker policy. Budgets follow the selected model, not a user-typed number.
export interface AIModelBudgets {
  context_window: number;
  max_output_tokens: number;
}

/** Unknown or unrecognized models. Wide enough for recent 128K APIs, not a 1M guess. */
export const DEFAULT_AI_MODEL_BUDGETS: AIModelBudgets = {
  context_window: 128_000,
  max_output_tokens: 8192,
};

/**
 * Current families only. Longest prefix wins.
 * Context above 1,000,000 and output above 128,000 are clamped to this app's validator.
 * Published sources: OpenAI compare (2026-10), Claude context windows, Gemini 4 Argon,
 * DeepSeek V4 (2026-04, output 384K clamped), Qwen3.8-Max (output 131,072 clamped).
 */
const RECENT_MODEL_BUDGETS: Array<{ prefix: string } & AIModelBudgets> = [
  { prefix: 'gpt-6.1-sol', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'gpt-6-astra', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'gpt-6-luna', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-mythos-5', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-fable-5', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-opus-5', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-sonnet-5', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-haiku-5', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-opus-4-8', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-opus-4-7', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-opus-4-6', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'claude-sonnet-4-6', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'gemini-4-argon', context_window: 1_000_000, max_output_tokens: 65_536 },
  { prefix: 'deepseek-v4-pro', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'deepseek-v4-flash', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'deepseek-flash', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'qwen3.8-max', context_window: 1_000_000, max_output_tokens: 128_000 },
  { prefix: 'qwen3.8-flash', context_window: 1_000_000, max_output_tokens: 8192 },
  { prefix: 'qwen3.7-plus', context_window: 1_000_000, max_output_tokens: 8192 },
];

const CONTEXT_FIELDS = ['context_window', 'context_length', 'max_model_len', 'max_input_tokens'];
const OUTPUT_FIELDS = ['max_output_tokens', 'max_completion_tokens'];

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function firstInteger(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Optional lengths from a provider's own /models entry. Official OpenAI lists do not include these. */
export function readProviderModelLimits(value: unknown): Partial<AIModelBudgets> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const context = firstInteger(record, CONTEXT_FIELDS);
  const output = firstInteger(record, OUTPUT_FIELDS);
  return {
    ...(context ? { context_window: context } : {}),
    ...(output ? { max_output_tokens: output } : {}),
  };
}

export function normalizeModelId(model: string): string {
  const bare = model.trim().toLowerCase().split('/').pop() ?? '';
  return bare;
}

/** Provider-reported limits win. Otherwise a recent-model prefix, otherwise the unknown-model default. */
export function resolveModelBudget(
  model: string,
  provider?: Partial<AIModelBudgets> | null
): AIModelBudgets {
  const hintedContext = provider?.context_window;
  const hintedOutput = provider?.max_output_tokens;
  if (inRange(hintedContext, 8192, 1_000_000)) {
    const output = inRange(hintedOutput, 256, 128_000) && hintedOutput < hintedContext
      ? hintedOutput
      // Missing/invalid output metadata must leave room for instructions, tools and observations.
      : Math.min(DEFAULT_AI_MODEL_BUDGETS.max_output_tokens, Math.floor(hintedContext / 4));
    return { context_window: hintedContext, max_output_tokens: output };
  }
  const id = normalizeModelId(model);
  const match = RECENT_MODEL_BUDGETS
    .filter(item => id === item.prefix || id.startsWith(`${item.prefix}-`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (match) return { context_window: match.context_window, max_output_tokens: match.max_output_tokens };
  return { ...DEFAULT_AI_MODEL_BUDGETS };
}

/** Validates an already chosen pair. Prefer resolveModelBudget for agent runs. */
export function resolveAIModelBudgets(
  value: { context_window?: unknown; max_output_tokens?: unknown },
  defaults: AIModelBudgets = DEFAULT_AI_MODEL_BUDGETS
): AIModelBudgets {
  const context = value.context_window ?? defaults.context_window;
  const output = value.max_output_tokens ?? defaults.max_output_tokens;
  if (!inRange(context, 8192, 1_000_000) || !inRange(output, 256, 128_000) || output >= context) {
    throw new Error('Invalid AI token budgets');
  }
  return { context_window: context, max_output_tokens: output };
}
