import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../frontend/src/i18n';
import { localizedSSHMessage } from '../frontend/src/terminal-status';

describe('SSH 状态国际化', () => {
  beforeEach(() => setLocale('en-US', { persist: false }));

  it('翻译认证流程状态，不回退显示后端中文', () => {
    expect(localizedSSHMessage('认证服务已接受，正在认证...', 'auth_service_accepted'))
      .toBe('Authentication service accepted; authenticating…');
    expect(localizedSSHMessage('正在使用密钥认证...', 'auth_public_key'))
      .toBe('Authenticating with a public key…');
    expect(localizedSSHMessage('认证失败：用户名或密码错误', 'auth_failed'))
      .toBe('Authentication failed: incorrect username or password');
  });

  it('保留指纹和错误详情等动态参数', () => {
    expect(localizedSSHMessage('后端回退消息', 'host_key_actual', {
      fingerprint: 'SHA256:example',
      keyType: 'ssh-ed25519',
    })).toBe('Actual fingerprint: SHA256:example (ssh-ed25519)');

    expect(localizedSSHMessage('后端回退消息', 'packet_error', {
      message: 'invalid packet',
    })).toBe('Packet processing error: invalid packet');
  });

  it('未知事件保持后端原始消息，兼容旧服务端', () => {
    expect(localizedSSHMessage('legacy message', 'unknown_event')).toBe('legacy message');
  });
});
