import { MCP_SCOPES, type McpGrant, type McpScope } from '../../src/mcp-schema';

/** One dialog's full grant draft. Search, disclosure and layout never own permission state. */
export class McpGrantDraft {
  private saved = new Map<number, readonly McpScope[]>();
  private current = new Map<number, readonly McpScope[]>();
  private changed = new Set<number>();

  private readonly serverIds: Set<number>;

  constructor(serverIds: readonly number[], grants: readonly McpGrant[]) {
    this.serverIds = new Set(serverIds);
    this.reset(grants);
  }

  reset(grants: readonly McpGrant[]): void {
    const byId = new Map(grants.map((grant) => [grant.serverId, grant.scopes]));
    this.saved.clear();
    for (const id of this.serverIds) {
      const scopes = MCP_SCOPES.filter((scope) => byId.get(id)?.includes(scope));
      if (scopes.length) this.saved.set(id, scopes);
    }
    this.current = new Map(this.saved);
    this.changed.clear();
  }

  removeServer(id: number): void {
    this.serverIds.delete(id);
    this.saved.delete(id);
    this.current.delete(id);
    this.changed.delete(id);
  }

  scopes(id: number): readonly McpScope[] {
    return this.current.get(id) ?? [];
  }

  wasAuthorized(id: number): boolean {
    return this.saved.has(id);
  }

  setScope(id: number, scope: McpScope, enabled: boolean): void {
    if (!this.serverIds.has(id)) return;
    const old = this.scopes(id);
    if (old.includes(scope) === enabled) return;
    const next = MCP_SCOPES.filter((s) => (s === scope ? enabled : old.includes(s)));
    if (next.length) this.current.set(id, next);
    else this.current.delete(id);
    const saved = this.saved.get(id) ?? [];
    if (next.length === saved.length && next.every((s, i) => saved[i] === s)) this.changed.delete(id);
    else this.changed.add(id);
  }

  get authorizedCount(): number { return this.current.size; }
  get changedCount(): number { return this.changed.size; }

  grants(): McpGrant[] {
    return [...this.serverIds].flatMap((serverId) => {
      const scopes = this.current.get(serverId);
      return scopes ? [{ serverId, scopes: [...scopes] }] : [];
    });
  }
}
