// Never pass provider messages/bodies through this boundary: they may echo credentials or input.
export const RESPONSE_ERROR_CODES = [
  'ai_not_configured', 'responses_address', 'responses_storage', 'responses_stateful_required',
  'responses_http', 'responses_chain', 'responses_invalid',
  'responses_incomplete', 'responses_failed', 'responses_stream', 'responses_redirect',
  'responses_schema', 'responses_history', 'responses_config_changed', 'responses_input',
  'responses_budget', 'responses_timeout', 'responses_empty', 'responses_key_required', 'responses_limits',
  'responses_memory_storage', 'responses_memory_conflict',
] as const;

export const RESPONSE_PURPOSES = ['main', 'checkpoint', 'memory'] as const;
export const RESPONSE_STAGES = ['http', 'stream', 'parse'] as const;
export const RESPONSE_PARAMETERS = [
  'model', 'input', 'max_output_tokens', 'prompt_cache_key', 'truncation',
  'parallel_tool_calls', 'tool_choice', 'tools', 'tools.strict', 'text.format', 'include', 'store',
  'reasoning', 'reasoning.effort',
] as const;
export const PROVIDER_ERROR_CODES = [
  'unsupported_parameter', 'unsupported_value', 'unsupported_feature', 'unsupported_model',
  'invalid_request_error', 'invalid_parameter', 'invalid_value', 'invalid_json_schema',
  'context_length_exceeded', 'max_tokens_exceeded', 'model_not_found', 'rate_limit_exceeded',
  'insufficient_quota', 'authentication_error', 'invalid_api_key', 'permission_denied',
  'server_error', 'internal_server_error', 'overloaded_error', 'content_policy_violation',
] as const;

export const RESPONSE_INCOMPLETE_REASONS = ['max_output_tokens', 'content_filter', 'unknown'] as const;

export interface ResponseDiagnostics {
  purpose?: typeof RESPONSE_PURPOSES[number];
  stage?: typeof RESPONSE_STAGES[number];
  parameter?: typeof RESPONSE_PARAMETERS[number];
  providerCode?: typeof PROVIDER_ERROR_CODES[number];
  requestId?: string;
  incompleteReason?: typeof RESPONSE_INCOMPLETE_REASONS[number];
  requestedOutputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

function member<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find(item => item === value);
}

/** Also validate on the browser side; WebSocket data is not a license to render arbitrary metadata. */
export function normalizeResponseDiagnostics(value: unknown): ResponseDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: ResponseDiagnostics = {};
  const purpose = member(RESPONSE_PURPOSES, raw.purpose);
  const stage = member(RESPONSE_STAGES, raw.stage);
  const parameter = member(RESPONSE_PARAMETERS, raw.parameter);
  const providerCode = member(PROVIDER_ERROR_CODES, raw.providerCode);
  if (purpose) result.purpose = purpose;
  if (stage) result.stage = stage;
  if (parameter) result.parameter = parameter;
  if (providerCode) result.providerCode = providerCode;
  const incompleteReason = member(RESPONSE_INCOMPLETE_REASONS, raw.incompleteReason);
  if (incompleteReason) result.incompleteReason = incompleteReason;
  for (const key of ['requestedOutputTokens', 'outputTokens', 'reasoningTokens'] as const) {
    const count = raw[key];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000) {
      result[key] = count;
    }
  }
  // This is OUR generated correlation UUID, not an untrusted upstream header or echoed secret.
  if (typeof raw.requestId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.requestId)) {
    result.requestId = raw.requestId;
  }
  return result;
}

/** For DEBUG_MODE terminal output only; never log a raw error, frame, or provider body. */
export function responseErrorDebugMessage(code: unknown, status: unknown, details: unknown): string {
  const known = member(RESPONSE_ERROR_CODES, code) ?? 'responses_failed';
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status : undefined;
  return 'Agent Responses failure: ' + JSON.stringify({ code: known, status: httpStatus,
    ...normalizeResponseDiagnostics(details) });
}
