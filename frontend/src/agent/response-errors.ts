import { t } from '../i18n';

const RESPONSE_ERROR_CODES = [
  'ai_not_configured', 'responses_address', 'responses_storage', 'responses_stateful_required',
  'responses_http', 'responses_chain', 'responses_invalid',
  'responses_incomplete', 'responses_failed', 'responses_stream', 'responses_redirect',
  'responses_schema', 'responses_history', 'responses_config_changed', 'responses_input',
  'responses_budget', 'responses_timeout', 'responses_empty', 'responses_key_required',
] as const;

export function responseErrorMessage(code: unknown, status?: number): string {
  const known = RESPONSE_ERROR_CODES.find(value => value === code) || 'responses_failed';
  return t(`agent.errors.${known}` as Parameters<typeof t>[0], { status: status || '' });
}
