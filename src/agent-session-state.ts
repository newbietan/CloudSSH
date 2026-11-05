/** Small, in-memory UI recovery view; never a task journal or an authorization credential. */
export const MAX_AGENT_RECOVERY_TEXT_CHARS = 32_000;

export interface AgentSessionState {
  runId: number;
  requestId: string | null;
  phase: 'idle' | 'thinking' | 'executing' | 'waiting_confirmation' | 'stopping';
  iteration: number;
  tool?: string;
  text: string;
  textId: number;
  textComplete: boolean;
  textTruncated: boolean;
  messageKey?: 'agent.stopped' | 'agent.iterationLimit';
  outcome?: 'completed' | 'stopped' | 'failed' | 'limit';
  errorCode?: string;
  errorStatus?: number;
  confirmation?: { confirmationId: string; command: string; reason: string };
}

export function emptyAgentSessionState(runId = 0, requestId: string | null = null): AgentSessionState {
  return {
    runId, requestId, phase: 'idle', iteration: 0, text: '', textId: 0,
    textComplete: true, textTruncated: false,
  };
}

export function isAgentSessionState(value: unknown): value is AgentSessionState {
  if (!value || typeof value !== 'object') return false;
  const state = value as AgentSessionState;
  const confirmation = state.confirmation;
  return Number.isSafeInteger(state.runId) && state.runId >= 0 &&
    (state.requestId === null || typeof state.requestId === 'string') &&
    ['idle', 'thinking', 'executing', 'waiting_confirmation', 'stopping'].includes(state.phase) &&
    Number.isSafeInteger(state.iteration) && state.iteration >= 0 &&
    Number.isSafeInteger(state.textId) && state.textId >= 0 &&
    typeof state.text === 'string' && state.text.length <= MAX_AGENT_RECOVERY_TEXT_CHARS &&
    typeof state.textComplete === 'boolean' && typeof state.textTruncated === 'boolean' &&
    (state.tool === undefined || typeof state.tool === 'string') &&
    (state.messageKey === undefined || ['agent.stopped', 'agent.iterationLimit'].includes(state.messageKey)) &&
    (state.phase !== 'waiting_confirmation' || !!confirmation) &&
    (!confirmation || (typeof confirmation.confirmationId === 'string' &&
      typeof confirmation.command === 'string' && typeof confirmation.reason === 'string'));
}
