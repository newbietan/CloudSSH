import { describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';
import type { SSHConnectionConfig } from '../../src/types';

function makeSharedSession() {
  const sent: unknown[] = [];
  const ws = {
    readyState: 1,
    send: vi.fn((value: unknown) => sent.push(value)),
    close: vi.fn(),
  } as unknown as WebSocket;
  const socket = { close: vi.fn() };
  const config: SSHConnectionConfig = {
    host: 'ssh.example.com',
    port: 22,
    username: 'alice',
    password: 'secret',
    authMethod: 'password',
    sessionPolicy: {
      source: 'share',
      shareId: 'share-1',
      shareRef: 'ref-1',
      allowAgent: false,
      allowSftp: true,
      allowMetadataMutation: false,
      allowHostKeyMutation: false,
      allowReconnect: false,
      sessionExpiresAt: Date.now() + 60_000,
    },
  };
  return { session: new SSHSession(ws, socket, config), sent };
}

describe('分享 SSH 会话能力策略', () => {
  it('后端拒绝 Agent 和 keyboard-interactive，不依赖前端隐藏按钮', async () => {
    const { session, sent } = makeSharedSession();
    await (session as any).handleAgentStart('run something', '1', 'zh-CN');
    expect(sent.map(String).join('\n')).toContain('分享会话不允许使用 AI Agent');
    expect((session as any).canUseAuthMethod('keyboard-interactive')).toBe(false);
  });

  it('跳板会话可单独禁用 keyboard-interactive，不需要复制完整分享策略', () => {
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
    const socket = { close: vi.fn() };
    const config: SSHConnectionConfig = {
      host: 'jump.example.com',
      port: 22,
      username: 'jump-user',
      password: 'secret',
      authMethod: 'password',
    };
    const session = new SSHSession(
      ws,
      socket,
      config,
      true,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      { openShellOnAuth: false, ownsWebSocket: false, allowKeyboardInteractive: false },
    );

    expect((session as any).canUseAuthMethod('password')).toBe(true);
    expect((session as any).canUseAuthMethod('keyboard-interactive')).toBe(false);
  });

  it('分享会话遇到主机指纹变更时直接阻断，不向接收者开放信任替换入口', () => {
    const { session, sent } = makeSharedSession();
    (session as any).config.expectedFingerprint = 'SHA256:known';
    (session as any).hostKeyFingerprint = 'SHA256:changed';
    (session as any).hostKeyType = 'ssh-ed25519';

    expect((session as any).finalizeHostKeyTrust(true)).toBe(false);
    const messages = sent.map((value) => JSON.parse(String(value)) as { type?: string });
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'host_key_changed' }));
    expect(sent.map(String).join('\n')).toContain('主机密钥指纹变更');
    expect(sent.map(String).join('\n')).toContain('分享会话不允许替换');
  });

  it('审计尚未就绪时不向 SSH Shell 转发任何终端输入', async () => {
    const { session } = makeSharedSession();
    (session as any).state = 'ready';
    await session.handleWebSocketMessage('whoami\r');
    expect((session as any).channelDataQueue).toHaveLength(0);

    (session as any).shareAuditStarted = true;
    await session.handleWebSocketMessage('whoami\r');
    expect((session as any).channelDataQueue).toHaveLength(1);
  });
});
