import { MCP_SCOPES, type McpGrant } from '../../src/mcp-schema';

/** Grants are a set, so server and scope ordering must not produce a dirty form. */
export function equalMcpGrants(a: readonly McpGrant[], b: readonly McpGrant[]): boolean {
  const canonical = (grants: readonly McpGrant[]) =>
    JSON.stringify(
      [...grants]
        .sort((x, y) => x.serverId - y.serverId)
        .map((grant) => [
          grant.serverId,
          MCP_SCOPES.filter((scope) => grant.scopes.includes(scope)),
        ])
    );
  return canonical(a) === canonical(b);
}
