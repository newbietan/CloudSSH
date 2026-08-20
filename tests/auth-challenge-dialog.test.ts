import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeAuthChallengeMessage,
  sanitizeAuthChallengeText,
} from '../frontend/src/auth-challenge-dialog';

describe('keyboard-interactive 挑战消息', () => {
  it('接受多提示、零提示和已有密码操作所需的消息字段', () => {
    expect(normalizeAuthChallengeMessage({
      type: 'auth_challenge',
      id: 'round-1',
      name: 'Two-factor authentication',
      instruction: '先输入密码\r\n再输入 OTP',
      prompts: [
        { text: 'Password: ', echo: false },
        { text: 'OTP: ', echo: true },
      ],
      canUseStoredPassword: true,
    })).toEqual({
      type: 'auth_challenge',
      id: 'round-1',
      name: 'Two-factor authentication',
      instruction: '先输入密码\n再输入 OTP',
      prompts: [
        { text: 'Password: ', echo: false },
        { text: 'OTP: ', echo: true },
      ],
      canUseStoredPassword: true,
    });

    expect(normalizeAuthChallengeMessage({
      type: 'auth_challenge',
      id: 'round-2',
      name: '',
      instruction: '',
      prompts: [],
    })?.prompts).toEqual([]);
  });

  it('过滤控制字符和双向覆盖字符，并限制远程展示文本长度', () => {
    expect(sanitizeAuthChallengeText('OTP\u001b\u0000\u202e: 123\r\nnext', 100, true))
      .toBe('OTP: 123\nnext');
    expect(sanitizeAuthChallengeText('line 1\nline 2', 100))
      .toBe('line 1 line 2');
    expect(sanitizeAuthChallengeText('abcdef', 3)).toBe('abc…');
  });

  it('拒绝畸形提示、超量提示和不透明 ID 缺失的消息', () => {
    expect(normalizeAuthChallengeMessage({
      type: 'auth_challenge', id: '', prompts: [],
    })).toBeNull();
    expect(normalizeAuthChallengeMessage({
      type: 'auth_challenge', id: 'bad', prompts: [{ text: 'Password', echo: 'no' }],
    })).toBeNull();
    expect(normalizeAuthChallengeMessage({
      type: 'auth_challenge', id: 'bad-copy', name: 42, instruction: '', prompts: [],
    })).toBeNull();
    expect(normalizeAuthChallengeMessage({
      type: 'auth_challenge',
      id: 'too-many',
      prompts: Array.from({ length: 33 }, () => ({ text: '', echo: false })),
    })).toBeNull();
  });
});

describe('keyboard-interactive 浏览器交互边界', () => {
  const dialogSource = readFileSync(
    new URL('../frontend/src/auth-challenge-dialog.ts', import.meta.url),
    'utf8',
  );
  const terminalSource = readFileSync(
    new URL('../frontend/src/terminal.ts', import.meta.url),
    'utf8',
  );
  const authFormSource = readFileSync(
    new URL('../frontend/src/auth-form.ts', import.meta.url),
    'utf8',
  );
  const styleSource = readFileSync(
    new URL('../frontend/src/style.css', import.meta.url),
    'utf8',
  );

  it('使用专用模态 dialog、显式标签和安全文本节点，不解析远程 HTML', () => {
    expect(dialogSource).toContain("document.createElement('dialog')");
    expect(dialogSource).toContain("dialog.setAttribute('aria-modal', 'true')");
    expect(dialogSource).toContain("dialog.setAttribute('aria-labelledby', titleId)");
    expect(dialogSource).toContain("dialog.setAttribute('aria-describedby', descriptionId)");
    expect(dialogSource).toContain('label.htmlFor = inputId');
    expect(dialogSource).toContain('element.textContent = text');
    expect(dialogSource).not.toContain('innerHTML');
    expect(styleSource).toContain('.auth-challenge-dialog::backdrop');
    expect(styleSource).toContain('var(--visual-viewport-height)');
    expect(dialogSource).toContain('if (!opened)');
    expect(dialogSource).toContain('options.onShown(challenge.id)');
    expect(dialogSource).toContain('onCancel(challengeId)');
  });

  it('按 echo 选择密码或明文输入，并仅为单个隐藏提示显示已有密码动作', () => {
    expect(dialogSource).toMatch(/input\.type\s*=\s*prompt\.echo\s*\?\s*['"]text['"]\s*:\s*['"]password['"]/);
    expect(dialogSource).toMatch(
      /challenge\.canUseStoredPassword[\s\S]*?&&[\s\S]*?challenge\.prompts\.length === 1[\s\S]*?&&[\s\S]*?!challenge\.prompts\[0\]\.echo/,
    );
    expect(dialogSource).toContain("useStoredPassword: true");
    expect(dialogSource).toContain("responses,\n    }");
  });

  it('每轮替换并清空旧字段，连接关闭、重连和销毁时移除弹窗', () => {
    expect(dialogSource).toContain('this.close(false)');
    expect(dialogSource).toContain("input.value = ''");
    expect(dialogSource).toContain('dialog.remove()');
    expect(dialogSource).toContain('if (this.dialog !== expectedDialog) return;');
    expect(terminalSource).toMatch(/onclose = \(event\) => \{[\s\S]*?authChallengeDialog\?\.dismiss\(\)/);
    expect(terminalSource).toMatch(/resetActiveConnection\(\): void \{\s*this\.authChallengeDialog\?\.dismiss\(\)/);
    expect(terminalSource).toContain('this.authChallengeDialog?.destroy()');
  });

  it('响应绑定产生挑战的 socket，旧连接无法向新连接发送敏感信息', () => {
    expect(terminalSource).toContain('this.handleAuthChallenge(socket, msg)');
    expect(terminalSource).toMatch(/onmessage = \(event\) => \{\s*if \(socket !== this\.ws\) return;/);
    expect(terminalSource).toContain('if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;');
    expect(terminalSource).toContain('socket.send(JSON.stringify(submission))');
    expect(terminalSource).toContain("socket.send(JSON.stringify({ type: 'auth_challenge_ack', id }))");
    expect(terminalSource).toContain("socket.send(JSON.stringify({ type: 'auth_cancel', id }))");
    expect(terminalSource).toMatch(/onCancel:[\s\S]*?this\.canReconnect = false/);
    expect(terminalSource).toContain('NON_RETRIABLE_AUTH_EVENTS');
    expect(terminalSource).toContain("'auth_interactive_client_unavailable'");
    expect(terminalSource).toContain("'auth_interactive_failed'");
    expect(terminalSource).toContain("'auth_failed'");
    expect(terminalSource).toContain("socket.close(1000, 'Invalid authentication challenge')");
    expect(terminalSource).toContain('this.rejectAuthChallenge(socket, msg)');
    expect(terminalSource).toContain('Only parsing failures are terminal output');
  });

  it('只提交用户当前选定认证方式对应的凭据', () => {
    expect(authFormSource).toContain(
      "const selectedPassword = this.authMode === 'password' ? password : undefined;",
    );
    expect(authFormSource).toContain(
      "const selectedPrivateKey = this.authMode === 'key' ? privateKey : undefined;",
    );
    expect(authFormSource).toContain('password: selectedPassword,');
    expect(authFormSource).toContain('privateKey: selectedPrivateKey,');
  });
});
