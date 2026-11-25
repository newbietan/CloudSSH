export const SSH_EXEC_ERROR_CODES = [
  'exec_channel_rejected',
  'exec_channel_timeout',
  'exec_channel_closed',
  'exec_rejected',
  'exec_timeout',
  'exec_transport_closed',
  'exec_cancelled',
  'exec_result_unknown',
  'exec_failed',
] as const;

export type SshExecErrorCode = (typeof SSH_EXEC_ERROR_CODES)[number];

/** Fixed protocol outcomes. Never include command text or upstream diagnostics. */
export class SshExecError extends Error {
  constructor(
    readonly code: SshExecErrorCode,
    readonly outcome: 'not_executed' | 'unknown'
  ) {
    super(code);
  }
}
