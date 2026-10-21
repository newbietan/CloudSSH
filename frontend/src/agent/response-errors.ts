import { normalizeResponseDiagnostics, RESPONSE_ERROR_CODES } from '../../../src/agent-response-diagnostics';
import { t } from '../i18n';

export function responseErrorMessage(code: unknown, status?: number, details?: unknown): string {
  const known = RESPONSE_ERROR_CODES.find(value => value === code) || 'responses_failed';
  const httpStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status! : '';
  const diagnostics = normalizeResponseDiagnostics(details);
  const base = t(`agent.errors.${known}` as Parameters<typeof t>[0], { status: httpStatus });
  // Technical diagnostics belong to the DEBUG_MODE terminal channel, never chat/toasts.
  return diagnostics.purpose === 'checkpoint'
    ? t('agent.checkpointFailure') + '\n' + (known === 'responses_incomplete' ? t('agent.checkpointIncomplete') : base)
    : base;
}
