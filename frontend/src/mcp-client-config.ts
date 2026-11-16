/** Client configuration assembly; the account settings API stores recoverable credentials encrypted. */
export interface McpAccessCredentials {
  clientId: string;
  clientSecret: string;
}

export function normalizeMcpAccessCredentials(input: McpAccessCredentials): McpAccessCredentials {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  const valid = (value: string, max: number) =>
    value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
  if (!valid(clientId, 512) || !valid(clientSecret, 4096))
    throw new Error('invalid_access_credentials');
  return { clientId, clientSecret };
}

export function buildMcpClientConfig(origin: string, token: string, access?: McpAccessCredentials) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (access) {
    const normalized = normalizeMcpAccessCredentials(access);
    headers['CF-Access-Client-Id'] = normalized.clientId;
    headers['CF-Access-Client-Secret'] = normalized.clientSecret;
  }
  return { mcpServers: { cloudssh: { type: 'http', url: new URL('/mcp', origin).href, headers } } };
}
