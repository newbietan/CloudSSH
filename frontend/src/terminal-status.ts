import { t, type TranslationKey, type TranslationParams } from './i18n';

const SSH_EVENT_KEYS: Record<string, TranslationKey> = {
  version_exchange: 'terminal.status.versionExchange',
  version_ready: 'terminal.status.versionReady',
  auth_public_key: 'terminal.status.authPublicKey',
  auth_service_accepted: 'terminal.status.authServiceAccepted',
  auth_success: 'terminal.status.authSuccess',
  auth_failed: 'terminal.status.authFailed',
  shell_ready: 'terminal.status.shellReady',
  session_ended: 'terminal.status.sessionEnded',
  remote_closed: 'terminal.status.remoteClosed',
  keepalive_timeout: 'terminal.status.keepaliveTimeout',
  packet_error: 'terminal.status.packetError',
  algorithm_error: 'terminal.status.algorithmError',
  service_error: 'terminal.status.serviceError',
  host_key_accepted: 'terminal.status.hostKeyAccepted',
  host_key_first_seen: 'terminal.status.hostKeyFirstSeen',
  host_key_changed: 'terminal.status.hostKeyChanged',
  host_key_known: 'terminal.status.hostKeyKnown',
  host_key_actual: 'terminal.status.hostKeyActual',
  host_key_trust_instruction: 'terminal.status.hostKeyTrustInstruction',
  host_key_unsupported: 'terminal.status.hostKeyUnsupported',
  host_key_verify_skipped: 'terminal.status.hostKeyVerifySkipped',
  host_key_signature_blocked: 'terminal.status.hostKeySignatureBlocked',
  host_key_signature_risk: 'terminal.status.hostKeySignatureRisk',
  host_key_signature_error: 'terminal.status.hostKeySignatureError',
  channel_rejected: 'terminal.status.channelRejected',
  pty_shell_rejected: 'terminal.status.ptyShellRejected',
  send_data_failed: 'terminal.status.sendDataFailed',
  resize_failed: 'terminal.status.resizeFailed',
};

export function localizedSSHMessage(
  message: string,
  event?: string,
  params: TranslationParams = {},
): string {
  const key = event ? SSH_EVENT_KEYS[event] : undefined;
  return key ? t(key, params) : message;
}
