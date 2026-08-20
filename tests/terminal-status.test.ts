import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../frontend/src/i18n';
import { localizedSSHMessage } from '../frontend/src/terminal-status';

describe('SSH 状态国际化', () => {
  beforeEach(() => setLocale('en-US', { persist: false }));

  it('翻译认证流程状态，不回退显示后端中文', () => {
    expect(localizedSSHMessage('认证服务已接受，正在认证...', 'auth_service_accepted')).toBe(
      'Authentication service accepted; authenticating…'
    );
    expect(localizedSSHMessage('正在使用密钥认证...', 'auth_public_key')).toBe(
      'Authenticating with a public key…'
    );
    expect(localizedSSHMessage('认证失败：用户名或密码错误', 'auth_failed')).toBe(
      'Authentication failed: the username, credential, or interactive response was rejected'
    );
    expect(localizedSSHMessage('服务器要求交互式认证', 'auth_interactive_required')).toBe(
      'The server requires interactive authentication'
    );
    expect(localizedSSHMessage('交互式认证失败', 'auth_interactive_failed')).toBe(
      'Interactive authentication failed: the server rejected the response'
    );
    expect(localizedSSHMessage('等待响应超时', 'auth_interactive_timeout')).toBe(
      'Timed out waiting for an interactive authentication response'
    );
    expect(localizedSSHMessage('浏览器未展示', 'auth_interactive_client_unavailable')).toBe(
      'The browser could not display the interactive authentication request. Refresh the page and try again.'
    );
  });

  it('保留指纹和错误详情等动态参数', () => {
    expect(
      localizedSSHMessage('后端回退消息', 'host_key_actual', {
        fingerprint: 'SHA256:example',
        keyType: 'ssh-ed25519',
      })
    ).toBe('Actual fingerprint: SHA256:example (ssh-ed25519)');

    expect(
      localizedSSHMessage('后端回退消息', 'host_key_not_saved', {
        fingerprint: 'SHA256:example',
        keyType: 'ssh-ed25519',
      })
    ).toBe('Server fingerprint: SHA256:example (ssh-ed25519, signature unverified, not saved)');

    expect(localizedSSHMessage('后端回退消息', 'host_key_unverified_instruction')).toBe(
      'Connection blocked because the host-key signature could not be verified. The new fingerprint cannot be trusted.'
    );

    expect(
      localizedSSHMessage('后端回退消息', 'packet_error', {
        message: 'invalid packet',
      })
    ).toBe('Packet processing error: invalid packet');
  });

  it('未知事件保持后端原始消息，兼容旧服务端', () => {
    expect(localizedSSHMessage('legacy message', 'unknown_event')).toBe('legacy message');
  });
});
