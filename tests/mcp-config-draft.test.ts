import { describe, expect, it } from 'vitest';
import { McpGrantDraft } from '../frontend/src/mcp-config-draft';
import type { McpGrant } from '../src/mcp-schema';

describe('MCP saved permission baseline', () => {
  it('normalizes ordering without mutating the saved grants or sharing a writable snapshot', () => {
    const saved: McpGrant[] = [{ serverId: 3, scopes: ['exec', 'read'] }, { serverId: 1, scopes: ['context'] }];
    const before = JSON.stringify(saved);
    const draft = new McpGrantDraft([1, 3], saved);
    const grants = draft.grants();
    expect(grants).toEqual([{ serverId: 1, scopes: ['context'] }, { serverId: 3, scopes: ['read', 'exec'] }]);
    grants[0].scopes.pop();
    draft.setScope(3, 'read', false);
    draft.setScope(3, 'read', true);
    expect(draft.scopes(1)).toEqual(['context']);
    expect(draft.changedCount).toBe(0);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('does not resurrect a removed server on a late edit or an older save response', () => {
    const saved: McpGrant[] = [{ serverId: 1, scopes: ['read'] }, { serverId: 3, scopes: ['exec'] }];
    const draft = new McpGrantDraft([1, 3], saved);
    draft.setScope(3, 'write', true);
    draft.removeServer(1); draft.setScope(1, 'exec', true);
    expect(draft.grants()).toEqual([{ serverId: 3, scopes: ['write', 'exec'] }]);
    expect(draft.changedCount).toBe(1); expect(draft.authorizedCount).toBe(1);
    draft.reset(saved);
    expect(draft.grants()).toEqual([saved[1]]); expect(draft.wasAuthorized(1)).toBe(false);
  });

  it('counts servers rather than checkbox clicks; saved membership stays stable during edits', () => {
    const draft = new McpGrantDraft([1, 3], [{ serverId: 3, scopes: ['read'] }]);
    draft.setScope(3, 'read', false);
    draft.setScope(1, 'read', true);
    draft.setScope(1, 'write', true);
    expect(draft.grants()).toEqual([{ serverId: 1, scopes: ['read', 'write'] }]);
    expect(draft.wasAuthorized(3)).toBe(true);
    expect(draft.wasAuthorized(1)).toBe(false);
    expect(draft.authorizedCount).toBe(1);
    expect(draft.changedCount).toBe(2);
    draft.setScope(1, 'write', false);
    draft.setScope(1, 'read', false);
    expect(draft.changedCount).toBe(1);
    expect(draft.grants()).toEqual([]);
    draft.reset([{ serverId: 1, scopes: ['context'] }]);
    expect(draft.wasAuthorized(3)).toBe(false);
    expect(draft.wasAuthorized(1)).toBe(true);
    expect(draft.scopes(1)).toEqual(['context']);
    expect(draft.changedCount).toBe(0);
  });
});
