import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentSessionDraftKey,
  clearLegacyAgentSessionDrafts,
  clearUserAgentSessionDrafts,
} from '../frontend/src/agent/session-draft';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

beforeEach(() => vi.stubGlobal('localStorage', new MemoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('Agent draft account namespace', () => {
  it('uses globally stable GitHub IDs, not the colliding local user/server IDs', () => {
    expect(agentSessionDraftKey(42, 1)).toBe('cloudssh_agent_draft_42_1');
    expect(agentSessionDraftKey(43, 1)).toBe('cloudssh_agent_draft_43_1');
    expect(agentSessionDraftKey(42, 2)).toBe('cloudssh_agent_draft_42_2');
    expect(agentSessionDraftKey(-1, 1)).toBe('cloudssh_agent_draft_-1_1');
  });

  it.each([null, undefined, 0, -2, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'disables persistence for an absent/invalid owner %s', (owner) => {
      expect(agentSessionDraftKey(owner, 1)).toBeNull();
    }
  );

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'disables persistence for an absent/invalid server %s', (server) => {
      expect(agentSessionDraftKey(42, server)).toBeNull();
    }
  );

  it('logout removes every server draft for one account only, including adjacent keys', () => {
    const keys = [
      'cloudssh_agent_draft_42_1', 'cloudssh_agent_draft_42_2',
      'cloudssh_agent_draft_43_1', 'cloudssh_agent_draft_420_1',
      'cloudssh_agent_draft_-1_1', 'cloudssh_agent_mode', 'cloudssh_snippets',
    ];
    for (const key of keys) localStorage.setItem(key, key);
    clearUserAgentSessionDrafts(42);
    expect(localStorage.getItem(keys[0])).toBeNull();
    expect(localStorage.getItem(keys[1])).toBeNull();
    for (const key of keys.slice(2)) expect(localStorage.getItem(key)).toBe(key);
  });

  it('local administrator logout does not remove GitHub account drafts', () => {
    localStorage.setItem('cloudssh_agent_draft_-1_1', 'admin');
    localStorage.setItem('cloudssh_agent_draft_42_1', 'github');
    clearUserAgentSessionDrafts(-1);
    expect(localStorage.getItem('cloudssh_agent_draft_-1_1')).toBeNull();
    expect(localStorage.getItem('cloudssh_agent_draft_42_1')).toBe('github');
  });

  it('discards all old unowned drafts instead of assigning them to the next account', () => {
    const legacy = ['cloudssh_agent_draft_1', 'cloudssh_agent_draft_2', 'cloudssh_agent_draft_101'];
    for (const key of legacy) localStorage.setItem(key, 'unowned secret');
    localStorage.setItem('cloudssh_agent_draft_42_1', 'owned secret');
    localStorage.setItem('cloudssh_agent_mode', 'interactive');
    clearLegacyAgentSessionDrafts();
    for (const key of legacy) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem('cloudssh_agent_draft_42_1')).toBe('owned secret');
    expect(localStorage.getItem('cloudssh_agent_mode')).toBe('interactive');
  });

  it('an unknown owner never causes a global cleanup', () => {
    localStorage.setItem('cloudssh_agent_draft_42_1', 'owned secret');
    clearUserAgentSessionDrafts(null);
    clearUserAgentSessionDrafts(undefined);
    clearUserAgentSessionDrafts(0);
    expect(localStorage.getItem('cloudssh_agent_draft_42_1')).toBe('owned secret');
  });

  it('unavailable storage does not break login or logout', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => clearLegacyAgentSessionDrafts()).not.toThrow();
    expect(() => clearUserAgentSessionDrafts(42)).not.toThrow();
  });
});
