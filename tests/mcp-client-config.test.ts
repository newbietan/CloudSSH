import { describe, expect, it } from 'vitest';
import { buildMcpClientConfig, normalizeMcpAccessCredentials } from '../frontend/src/mcp-client-config';
import { assistantIconMarkup } from '../frontend/src/assistant-icons';

describe('browser-only MCP client configuration', () => {
  it('ordinary authentication produces only its personal Bearer header', () => {
    expect(buildMcpClientConfig('https://cloudssh.example', 'personal')).toEqual({
      mcpServers: { cloudssh: { type: 'http', url: 'https://cloudssh.example/mcp', headers: { Authorization: 'Bearer personal' } } },
    });
  });
  it('Access configuration preserves both independent authentication layers without modifying the token', () => {
    const input = { clientId: ' client.access ', clientSecret: ' secret ' };
    const config = buildMcpClientConfig('https://cloudssh.example', 'personal', input);
    expect(config.mcpServers.cloudssh.headers).toEqual({ Authorization: 'Bearer personal',
      'CF-Access-Client-Id': 'client.access', 'CF-Access-Client-Secret': 'secret' });
    expect(input).toEqual({ clientId: ' client.access ', clientSecret: ' secret ' });
  });
  it.each([
    { clientId: '', clientSecret: 'secret' }, { clientId: 'client', clientSecret: '' },
    { clientId: 'a b', clientSecret: 'secret' }, { clientId: 'a\r\nb', clientSecret: 'secret' },
    { clientId: 'client', clientSecret: 'a\nb' }, { clientId: '非ASCII', clientSecret: 'secret' },
    { clientId: 'a'.repeat(513), clientSecret: 'secret' }, { clientId: 'client', clientSecret: 'a'.repeat(4097) },
  ])('rejects incomplete or invalid Access header values: %j', input => {
    expect(() => normalizeMcpAccessCredentials(input)).toThrow('invalid_access_credentials');
  });
  it('keeps JSON-sensitive characters as literal credential data', () => {
    const secret = 'secret"<>&\\';
    const serialized = JSON.stringify(buildMcpClientConfig('https://cloudssh.example', 'personal', { clientId: 'id', clientSecret: secret }));
    expect(JSON.parse(serialized).mcpServers.cloudssh.headers['CF-Access-Client-Secret']).toBe(secret);
  });
});

describe('first-party assistant icon geometry', () => {
  it.each(['agent', 'mcp'] as const)('%s uses fixed accessible, theme-adaptive SVG without external assets', icon => {
    const svg = assistantIconMarkup(icon);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
    expect(svg).toContain(`data-assistant-glyph="${icon}"`);
    expect(svg).not.toMatch(/<script|<image|<use|href=|onload=|animation|material-symbols/);
  });
  it('distinguishes the AI dialogue icon from the external connection icon', () => {
    expect(assistantIconMarkup('agent')).not.toBe(assistantIconMarkup('mcp'));
    expect(assistantIconMarkup('mcp')).toContain('<circle');
  });
});
