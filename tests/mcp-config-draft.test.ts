import { describe, expect, it } from 'vitest';
import { equalMcpGrants } from '../frontend/src/mcp-config-draft';
import type { McpGrant } from '../src/mcp-schema';

describe('MCP saved permission baseline', () => {
  it('ignores ordering without mutating the saved grants', () => {
    const saved: McpGrant[] = [{ serverId: 3, scopes: ['exec', 'read'] }, { serverId: 1, scopes: ['context'] }];
    const before = JSON.stringify(saved);
    expect(equalMcpGrants(saved, [{ serverId: 1, scopes: ['context'] }, { serverId: 3, scopes: ['read', 'exec'] }])).toBe(true);
    expect(JSON.stringify(saved)).toBe(before);
  });
  it('detects per-server changes, removals, and restoration of empty access', () => {
    expect(equalMcpGrants([], [])).toBe(true);
    expect(equalMcpGrants([{ serverId: 1, scopes: ['read'] }], [{ serverId: 3, scopes: ['read'] }])).toBe(false);
    expect(equalMcpGrants([{ serverId: 1, scopes: ['read', 'write'] }], [{ serverId: 1, scopes: ['read'] }])).toBe(false);
    expect(equalMcpGrants([], [{ serverId: 1, scopes: ['read'] }])).toBe(false);
  });
});
