import { describe, expect, it } from 'vitest';
import {
  emptyAgentSessionState, isAgentSessionState, MAX_AGENT_RECOVERY_TEXT_CHARS,
} from '../src/agent-session-state';

describe('Agent recovery state wire contract', () => {
  it('accepts empty and bounded active states', () => {
    expect(isAgentSessionState(emptyAgentSessionState())).toBe(true);
    expect(isAgentSessionState({ ...emptyAgentSessionState(2, 'request'), phase: 'thinking',
      text: 'x'.repeat(MAX_AGENT_RECOVERY_TEXT_CHARS), textComplete: false })).toBe(true);
  });

  it.each([
    null,
    { ...emptyAgentSessionState(), runId: -1 },
    { ...emptyAgentSessionState(), textId: NaN },
    { ...emptyAgentSessionState(), text: 'x'.repeat(MAX_AGENT_RECOVERY_TEXT_CHARS + 1) },
    { ...emptyAgentSessionState(), messageKey: 'unknown-key' },
    { ...emptyAgentSessionState(), phase: 'waiting_confirmation' },
    { ...emptyAgentSessionState(), phase: 'waiting_confirmation', confirmation: {
      confirmationId: 'id', command: 123, reason: 'reason',
    } },
  ])('rejects malformed state without adopting its task: %j', state => {
    expect(isAgentSessionState(state)).toBe(false);
  });
});
