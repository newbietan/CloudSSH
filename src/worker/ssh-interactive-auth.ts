import { SSHAuth } from '../ssh/auth';
import type { SSHConnectionConfig } from '../types';

export const AUTH_CHALLENGE_ACK_TIMEOUT_MS = 10 * 1000;
export const AUTH_CHALLENGE_RESPONSE_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_KEYBOARD_INTERACTIVE_ROUNDS = 8;

export interface PendingAuthChallenge {
  id: string;
  prompts: Array<{ text: string; echo: boolean }>;
  phase: 'awaiting_ack' | 'awaiting_response';
  timeout: ReturnType<typeof setTimeout>;
}

export interface KeyboardInteractiveContext {
  getState: () => string;
  getActiveAuthMethod: () => string | null;
  resetActiveAuthMethod: () => void;
  getConfig: () => SSHConnectionConfig;
  sendWebSocketJSON: (msg: Record<string, unknown>) => void;
  sendEncrypted: (payload: Uint8Array) => Promise<void>;
  sendStatus: (message: string, code?: string) => void;
  sendError: (message: string, code?: string) => void;
  sendDebug: (message: string | (() => string)) => void;
  failAuthentication: (message: string, code?: string) => void;
  close: (normal?: boolean) => void;
}

export class KeyboardInteractiveAuthHandler {
  private pendingChallenge: PendingAuthChallenge | null = null;
  private rounds = 0;

  constructor(private readonly ctx: KeyboardInteractiveContext) {}

  get pendingAuthChallenge(): PendingAuthChallenge | null {
    return this.pendingChallenge;
  }

  set pendingAuthChallenge(challenge: PendingAuthChallenge | null) {
    this.pendingChallenge = challenge;
  }

  get keyboardInteractiveRounds(): number {
    return this.rounds;
  }

  set keyboardInteractiveRounds(rounds: number) {
    this.rounds = rounds;
  }

  hasPending(): boolean {
    return this.pendingChallenge !== null;
  }

  getRounds(): number {
    return this.rounds;
  }

  clear(): void {
    if (!this.pendingChallenge) return;
    clearTimeout(this.pendingChallenge.timeout);
    this.pendingChallenge = null;
  }

  handleInfoRequest(payload: Uint8Array): void {
    if (this.ctx.getActiveAuthMethod() !== 'keyboard-interactive') {
      this.ctx.failAuthentication(
        '服务器发送了当前认证方式不支持的交互消息',
        'auth_interactive_protocol_error'
      );
      return;
    }
    if (this.pendingChallenge) {
      this.ctx.failAuthentication(
        '服务器在上一轮响应前发送了新的交互式认证请求',
        'auth_interactive_protocol_error'
      );
      return;
    }
    if (this.rounds >= MAX_KEYBOARD_INTERACTIVE_ROUNDS) {
      this.ctx.failAuthentication('交互式认证轮次过多，连接已终止', 'auth_interactive_limit');
      return;
    }

    let request: ReturnType<typeof SSHAuth.parseKeyboardInteractiveInfoRequest>;
    try {
      request = SSHAuth.parseKeyboardInteractiveInfoRequest(payload);
    } catch {
      this.ctx.failAuthentication(
        '服务器发送了无效的交互式认证请求',
        'auth_interactive_protocol_error'
      );
      return;
    }

    this.rounds++;
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      if (this.pendingChallenge?.id !== id) return;
      this.pendingChallenge = null;
      this.ctx.sendError(
        '浏览器未确认显示交互式认证请求，请刷新页面后重试',
        'auth_interactive_client_unavailable'
      );
      this.ctx.close(true);
    }, AUTH_CHALLENGE_ACK_TIMEOUT_MS);

    this.pendingChallenge = {
      id,
      prompts: request.prompts.map((prompt) => ({ ...prompt })),
      phase: 'awaiting_ack',
      timeout,
    };

    const config = this.ctx.getConfig();
    try {
      this.ctx.sendWebSocketJSON({
        type: 'auth_challenge',
        id,
        name: request.name,
        instruction: request.instruction,
        prompts: request.prompts,
        host: config.host,
        port: config.port,
        canUseStoredPassword: Boolean(
          config.password &&
            config.authMethod !== 'publickey' &&
            request.prompts.length === 1 &&
            !request.prompts[0].echo
        ),
      });
    } catch {
      this.clear();
      this.ctx.close();
    }
  }

  handleAck(message: Record<string, unknown>): void {
    if (this.ctx.getState() !== 'auth' || this.ctx.getActiveAuthMethod() !== 'keyboard-interactive') {
      return;
    }

    const pending = this.pendingChallenge;
    if (!pending || typeof message.id !== 'string' || message.id !== pending.id) {
      this.ctx.sendError('交互式认证确认已过期或不匹配', 'auth_interactive_stale');
      return;
    }
    if (pending.phase === 'awaiting_response') return;

    clearTimeout(pending.timeout);
    pending.phase = 'awaiting_response';
    const id = pending.id;
    pending.timeout = setTimeout(() => {
      if (this.pendingChallenge?.id !== id) return;
      this.pendingChallenge = null;
      this.ctx.sendError('等待交互式认证响应超时', 'auth_interactive_timeout');
      this.ctx.close(true);
    }, AUTH_CHALLENGE_RESPONSE_TIMEOUT_MS);
    this.ctx.sendDebug('Browser displayed the interactive authentication challenge');
  }

  async handleResponse(message: Record<string, unknown>): Promise<void> {
    if (this.ctx.getState() !== 'auth' || this.ctx.getActiveAuthMethod() !== 'keyboard-interactive') {
      return;
    }

    const pending = this.pendingChallenge;
    if (!pending || typeof message.id !== 'string' || message.id !== pending.id) {
      this.ctx.sendError('交互式认证响应已过期或不匹配', 'auth_interactive_stale');
      return;
    }

    const config = this.ctx.getConfig();
    let responses: string[];
    if (message.useStoredPassword === true) {
      if (
        !config.password ||
        config.authMethod === 'publickey' ||
        pending.prompts.length !== 1 ||
        pending.prompts[0].echo ||
        Object.hasOwn(message, 'responses')
      ) {
        this.ctx.failAuthentication(
          '当前交互式认证请求不能使用已保存密码',
          'auth_interactive_invalid_response'
        );
        return;
      }
      responses = [config.password];
    } else {
      if (
        !Array.isArray(message.responses) ||
        message.responses.length !== pending.prompts.length ||
        !message.responses.every((response) => typeof response === 'string')
      ) {
        this.ctx.failAuthentication(
          '交互式认证响应数量或格式无效',
          'auth_interactive_invalid_response'
        );
        return;
      }
      responses = message.responses as string[];
    }

    let responsePayload: Uint8Array;
    try {
      responsePayload = SSHAuth.buildKeyboardInteractiveInfoResponse(responses);
    } catch {
      this.ctx.failAuthentication('交互式认证响应超过安全限制', 'auth_interactive_invalid_response');
      return;
    }

    this.clear();
    try {
      await this.ctx.sendEncrypted(responsePayload);
    } catch {
      this.ctx.sendError('发送交互式认证响应失败', 'auth_interactive_send_failed');
      this.ctx.close();
    }
  }

  handleCancel(message: Record<string, unknown>): void {
    if (this.ctx.getState() !== 'auth' || this.ctx.getActiveAuthMethod() !== 'keyboard-interactive') {
      return;
    }
    const pending = this.pendingChallenge;
    if (!pending || typeof message.id !== 'string' || message.id !== pending.id) return;

    this.clear();
    this.ctx.resetActiveAuthMethod();
    this.ctx.sendStatus('交互式认证已取消', 'auth_interactive_cancelled');
    this.ctx.close(true);
  }

  dispose(): void {
    this.clear();
  }
}
