import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSHSession } from '../../src/worker/ssh-session';
import { concat, encodeString, encodeUint32, readUint32 } from '../../src/ssh/utils';

function buildFailure(methods: string, partialSuccess = false): Uint8Array {
  return concat(
    new Uint8Array([51]),
    encodeString(methods),
    new Uint8Array([partialSuccess ? 1 : 0]),
  );
}

function buildInfoRequest(
  prompts: Array<{ text: string; echo: boolean }>,
  name = 'Interactive authentication',
  instruction = 'Complete the requested fields',
): Uint8Array {
  return concat(
    new Uint8Array([60]),
    encodeString(name),
    encodeString(instruction),
    encodeString(''),
    encodeUint32(prompts.length),
    ...prompts.flatMap((prompt) => [
      encodeString(prompt.text),
      new Uint8Array([prompt.echo ? 1 : 0]),
    ]),
  );
}

function readString(payload: Uint8Array, offset: number): { value: string; next: number } {
  const length = readUint32(payload, offset);
  const start = offset + 4;
  return {
    value: new TextDecoder().decode(payload.subarray(start, start + length)),
    next: start + length,
  };
}

function readInfoResponses(payload: Uint8Array): string[] {
  expect(payload[0]).toBe(61);
  const count = readUint32(payload, 1);
  const responses: string[] = [];
  let offset = 5;
  for (let index = 0; index < count; index++) {
    const response = readString(payload, offset);
    responses.push(response.value);
    offset = response.next;
  }
  expect(offset).toBe(payload.length);
  return responses;
}

function readAuthMethod(payload: Uint8Array): string {
  expect(payload[0]).toBe(50);
  let offset = 1;
  offset = readString(payload, offset).next; // username
  offset = readString(payload, offset).next; // service
  return readString(payload, offset).value;
}

function createSession(password = 'saved-secret') {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  };
  const socket = { close: vi.fn() };
  const session = new SSHSession(
    ws as unknown as WebSocket,
    socket as never,
    {
      host: 'ssh.example.com',
      port: 22,
      username: 'alice',
      password,
      authMethod: 'password',
    },
  );
  const sendEncrypted = vi.fn(async (_payload: Uint8Array) => {});
  (session as any).sendEncrypted = sendEncrypted;
  (session as any).state = 'auth';
  return { session, ws, socket, sendEncrypted };
}

function sentJson(ws: { send: ReturnType<typeof vi.fn> }, index = -1): any {
  const calls = ws.send.mock.calls;
  const selected = index < 0 ? calls[calls.length + index] : calls[index];
  return JSON.parse(selected[0] as string);
}

describe('SSHSession keyboard-interactive authentication', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('回传有界心跳 ID，供浏览器前台恢复时排除过期 pong', async () => {
    const { session, ws } = createSession();

    await session.handleWebSocketMessage(JSON.stringify({ type: 'ping', id: 'resume-probe-1' }));
    expect(sentJson(ws)).toEqual({ type: 'pong', id: 'resume-probe-1' });

    await session.handleWebSocketMessage(JSON.stringify({ type: 'ping', id: 'x'.repeat(129) }));
    expect(sentJson(ws)).toEqual({ type: 'pong' });
  });

  it('discovers methods with none before sending credentials and selects Serv00 keyboard-interactive', async () => {
    const { session, sendEncrypted } = createSession('top-secret');

    await (session as any).authenticate();
    expect(sendEncrypted).toHaveBeenCalledOnce();
    expect(readAuthMethod(sendEncrypted.mock.calls[0][0])).toBe('none');
    expect(new TextDecoder().decode(sendEncrypted.mock.calls[0][0])).not.toContain('top-secret');

    await (session as any).handleAuthPacket(
      51,
      buildFailure('publickey,keyboard-interactive'),
    );
    expect(sendEncrypted).toHaveBeenCalledTimes(2);
    expect(readAuthMethod(sendEncrypted.mock.calls[1][0])).toBe('keyboard-interactive');
  });

  it('selects the configured password after discovery and tolerates an omitted method list', async () => {
    const advertised = createSession();
    await (advertised.session as any).authenticate();
    await (advertised.session as any).handleAuthPacket(51, buildFailure('password'));
    expect(readAuthMethod(advertised.sendEncrypted.mock.calls[1][0])).toBe('password');

    const omitted = createSession();
    await (omitted.session as any).authenticate();
    await (omitted.session as any).handleAuthPacket(51, buildFailure(''));
    expect(readAuthMethod(omitted.sendEncrypted.mock.calls[1][0])).toBe('password');
  });

  it('does not reinterpret a rejected configured method as keyboard-interactive', async () => {
    const { session, sendEncrypted, ws } = createSession();
    (session as any).activeAuthMethod = 'password';
    (session as any).attemptedAuthMethods.add('password');

    await (session as any).handleAuthPacket(
      51,
      buildFailure('publickey,keyboard-interactive,password'),
    );

    expect(sendEncrypted).not.toHaveBeenCalled();
    expect(sentJson(ws)).toMatchObject({
      type: 'error',
      event: 'auth_failed',
    });
    expect(ws.close).toHaveBeenCalledWith(1000);
  });

  it('falls back once when the server no longer offers the configured method', async () => {
    const { session, sendEncrypted, ws } = createSession();
    (session as any).activeAuthMethod = 'password';
    (session as any).attemptedAuthMethods.add('password');

    await (session as any).handleAuthPacket(
      51,
      buildFailure('publickey,keyboard-interactive'),
    );

    expect(sendEncrypted).toHaveBeenCalledOnce();
    expect(readAuthMethod(sendEncrypted.mock.calls[0][0])).toBe('keyboard-interactive');
    expect((session as any).activeAuthMethod).toBe('keyboard-interactive');
    expect(sentJson(ws)).toMatchObject({
      type: 'status',
      event: 'auth_interactive_required',
    });

    // A later RFC 4256 failure is terminal and must not start a retry loop.
    await (session as any).handleAuthPacket(51, buildFailure('keyboard-interactive'));
    expect(sendEncrypted).toHaveBeenCalledOnce();
    expect(sentJson(ws)).toMatchObject({
      type: 'error',
      event: 'auth_interactive_failed',
    });
    expect(ws.close).toHaveBeenCalledWith(1000);
  });

  it('never selects a credential method the user did not choose', async () => {
    const passwordCase = createSession();
    (passwordCase.session as any).config.privateKey = 'hidden-key';
    (passwordCase.session as any).sessionID = new Uint8Array([1]);
    (passwordCase.session as any).activeAuthMethod = 'password';
    (passwordCase.session as any).attemptedAuthMethods.add('password');

    await (passwordCase.session as any).handleAuthPacket(
      51,
      buildFailure('publickey'),
    );

    expect(passwordCase.sendEncrypted).not.toHaveBeenCalled();
    expect(passwordCase.ws.close).toHaveBeenCalledWith(1000);

    const publicKeyCase = createSession();
    (publicKeyCase.session as any).config.authMethod = 'publickey';
    (publicKeyCase.session as any).config.privateKey = 'selected-key';
    (publicKeyCase.session as any).sessionID = new Uint8Array([1]);
    (publicKeyCase.session as any).activeAuthMethod = 'publickey';
    (publicKeyCase.session as any).attemptedAuthMethods.add('publickey');

    await (publicKeyCase.session as any).handleAuthPacket(
      51,
      buildFailure('password'),
    );

    expect(publicKeyCase.sendEncrypted).not.toHaveBeenCalled();
    expect(publicKeyCase.ws.close).toHaveBeenCalledWith(1000);
  });

  it('uses partial success to advance ordered multi-factor authentication stages', async () => {
    const { session, sendEncrypted } = createSession();
    (session as any).activeAuthMethod = 'password';
    (session as any).attemptedAuthMethods.add('password');

    // The server requires keyboard-interactive before password, so the
    // configured password attempt is rejected for ordering rather than value.
    await (session as any).handleAuthPacket(51, buildFailure('keyboard-interactive'));
    expect(readAuthMethod(sendEncrypted.mock.calls[0][0])).toBe('keyboard-interactive');

    // Completing that factor starts a new stage where password may be retried.
    await (session as any).handleAuthPacket(51, buildFailure('password', true));
    expect(readAuthMethod(sendEncrypted.mock.calls[1][0])).toBe('password');
    expect((session as any).partialAuthenticationStages).toBe(1);
    expect((session as any).activeAuthMethod).toBe('password');
  });

  it('allows the same advertised method in a new partial-success stage but caps stage loops', async () => {
    const repeat = createSession();
    (repeat.session as any).activeAuthMethod = 'keyboard-interactive';
    (repeat.session as any).attemptedAuthMethods.add('keyboard-interactive');
    await (repeat.session as any).handleAuthPacket(
      51,
      buildFailure('keyboard-interactive', true),
    );
    expect(readAuthMethod(repeat.sendEncrypted.mock.calls[0][0])).toBe('keyboard-interactive');

    const capped = createSession();
    (capped.session as any).activeAuthMethod = 'keyboard-interactive';
    (capped.session as any).attemptedAuthMethods.add('keyboard-interactive');
    (capped.session as any).partialAuthenticationStages = 8;
    await (capped.session as any).handleAuthPacket(
      51,
      buildFailure('keyboard-interactive', true),
    );
    expect(capped.sendEncrypted).not.toHaveBeenCalled();
    expect(sentJson(capped.ws)).toMatchObject({
      type: 'error',
      event: 'auth_interactive_limit',
    });
    expect(capped.ws.close).toHaveBeenCalledWith(1011);
  });

  it('forwards bounded prompts and substitutes the saved password only after explicit selection', async () => {
    const { session, sendEncrypted, ws } = createSession('top-secret');
    (session as any).activeAuthMethod = 'keyboard-interactive';
    (session as any).attemptedAuthMethods.add('keyboard-interactive');

    await (session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'Password: ', echo: false }]),
    );

    const challenge = sentJson(ws);
    expect(challenge).toMatchObject({
      type: 'auth_challenge',
      name: 'Interactive authentication',
      prompts: [{ text: 'Password: ', echo: false }],
      canUseStoredPassword: true,
    });
    expect(JSON.stringify(challenge)).not.toContain('top-secret');

    await session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_response',
      id: challenge.id,
      useStoredPassword: true,
    }));

    expect(sendEncrypted).toHaveBeenCalledOnce();
    expect(readInfoResponses(sendEncrypted.mock.calls[0][0])).toEqual(['top-secret']);
    expect((session as any).pendingAuthChallenge).toBeNull();
  });

  it('supports multiple prompts, zero-prompt rounds, and repeated rounds', async () => {
    const { session, sendEncrypted, ws } = createSession('');
    (session as any).activeAuthMethod = 'keyboard-interactive';
    (session as any).attemptedAuthMethods.add('keyboard-interactive');

    await (session as any).handleAuthPacket(60, buildInfoRequest([
      { text: 'Account: ', echo: true },
      { text: 'OTP: ', echo: false },
    ]));
    const first = sentJson(ws);
    await session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_response',
      id: first.id,
      responses: ['alice', '123456'],
    }));

    await (session as any).handleAuthPacket(
      60,
      buildInfoRequest([], 'Notice', 'Password changed'),
    );
    const second = sentJson(ws);
    expect(second.id).not.toBe(first.id);
    expect(second.prompts).toEqual([]);
    await session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_response',
      id: second.id,
      responses: [],
    }));

    expect(sendEncrypted).toHaveBeenCalledTimes(2);
    expect(readInfoResponses(sendEncrypted.mock.calls[0][0])).toEqual(['alice', '123456']);
    expect(readInfoResponses(sendEncrypted.mock.calls[1][0])).toEqual([]);
    expect((session as any).keyboardInteractiveRounds).toBe(2);
  });

  it('keeps the active challenge when a stale response arrives', async () => {
    const { session, sendEncrypted, ws } = createSession();
    (session as any).activeAuthMethod = 'keyboard-interactive';
    await (session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'OTP: ', echo: false }]),
    );
    const challenge = sentJson(ws);

    await session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_response',
      id: `${challenge.id}-stale`,
      responses: ['123456'],
    }));

    expect(sendEncrypted).not.toHaveBeenCalled();
    expect((session as any).pendingAuthChallenge.id).toBe(challenge.id);
    expect(sentJson(ws)).toMatchObject({ type: 'error', event: 'auth_interactive_stale' });
    (session as any).clearPendingAuthChallenge();
  });

  it('fails closed for invalid response shapes and unauthorized saved-password use', async () => {
    const first = createSession();
    (first.session as any).activeAuthMethod = 'keyboard-interactive';
    await (first.session as any).handleAuthPacket(60, buildInfoRequest([
      { text: 'Password: ', echo: false },
      { text: 'OTP: ', echo: false },
    ]));
    const firstChallenge = sentJson(first.ws);
    await first.session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_response',
      id: firstChallenge.id,
      responses: ['only-one'],
    }));
    expect(first.sendEncrypted).not.toHaveBeenCalled();
    expect(first.ws.close).toHaveBeenCalledWith(1011);

    const second = createSession();
    (second.session as any).activeAuthMethod = 'keyboard-interactive';
    await (second.session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'Username: ', echo: true }]),
    );
    const secondChallenge = sentJson(second.ws);
    await second.session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_response',
      id: secondChallenge.id,
      useStoredPassword: true,
    }));
    expect(second.sendEncrypted).not.toHaveBeenCalled();
    expect(second.ws.close).toHaveBeenCalledWith(1011);

    const publicKeyCase = createSession();
    (publicKeyCase.session as any).config.authMethod = 'publickey';
    (publicKeyCase.session as any).activeAuthMethod = 'keyboard-interactive';
    await (publicKeyCase.session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'Second factor: ', echo: false }]),
    );
    const publicKeyChallenge = sentJson(publicKeyCase.ws);
    expect(publicKeyChallenge.canUseStoredPassword).toBe(false);
    await publicKeyCase.session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_response',
      id: publicKeyChallenge.id,
      useStoredPassword: true,
    }));
    expect(publicKeyCase.sendEncrypted).not.toHaveBeenCalled();
    expect(publicKeyCase.ws.close).toHaveBeenCalledWith(1011);
  });

  it('distinguishes an undisplayed challenge from a displayed but unanswered challenge', async () => {
    const unavailableCase = createSession();
    (unavailableCase.session as any).activeAuthMethod = 'keyboard-interactive';
    await (unavailableCase.session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'OTP: ', echo: false }]),
    );
    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(sentJson(unavailableCase.ws)).toMatchObject({
      type: 'error',
      event: 'auth_interactive_client_unavailable',
    });
    expect(unavailableCase.ws.close).toHaveBeenCalledWith(1000);

    const timeoutCase = createSession();
    (timeoutCase.session as any).activeAuthMethod = 'keyboard-interactive';
    await (timeoutCase.session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'OTP: ', echo: false }]),
    );
    const timeoutChallenge = sentJson(timeoutCase.ws);
    await timeoutCase.session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_challenge_ack',
      id: timeoutChallenge.id,
    }));
    expect((timeoutCase.session as any).pendingAuthChallenge.phase).toBe('awaiting_response');
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(sentJson(timeoutCase.ws)).toMatchObject({
      type: 'error',
      event: 'auth_interactive_timeout',
    });
    expect(timeoutCase.ws.close).toHaveBeenCalledWith(1000);
  });

  it('cancellation closes normally without reconnect semantics', async () => {
    const cancelCase = createSession();
    (cancelCase.session as any).activeAuthMethod = 'keyboard-interactive';
    await (cancelCase.session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'OTP: ', echo: false }]),
    );
    const challenge = sentJson(cancelCase.ws);
    await cancelCase.session.handleWebSocketMessage(JSON.stringify({
      type: 'auth_cancel',
      id: challenge.id,
    }));
    expect(sentJson(cancelCase.ws)).toMatchObject({
      type: 'status',
      event: 'auth_interactive_cancelled',
    });
    expect(cancelCase.ws.close).toHaveBeenCalledWith(1000);
  });

  it('disambiguates msg 60 by auth method and caps the number of interactive rounds', async () => {
    const wrongContext = createSession();
    (wrongContext.session as any).activeAuthMethod = 'password';
    await (wrongContext.session as any).handleAuthPacket(
      60,
      buildInfoRequest([{ text: 'Password: ', echo: false }]),
    );
    expect(wrongContext.ws.close).toHaveBeenCalledWith(1011);
    expect(sentJson(wrongContext.ws)).toMatchObject({
      type: 'error',
      event: 'auth_password_change_required',
    });

    const publicKeyContext = createSession();
    (publicKeyContext.session as any).activeAuthMethod = 'publickey';
    await (publicKeyContext.session as any).handleAuthPacket(60, new Uint8Array([60]));
    expect(publicKeyContext.ws.close).toHaveBeenCalledWith(1011);
    expect(sentJson(publicKeyContext.ws)).toMatchObject({
      type: 'error',
      event: 'auth_protocol_error',
    });

    const discoveryContext = createSession();
    (discoveryContext.session as any).activeAuthMethod = 'none';
    await (discoveryContext.session as any).handleAuthPacket(60, new Uint8Array([60]));
    expect(discoveryContext.ws.close).toHaveBeenCalledWith(1011);
    expect(sentJson(discoveryContext.ws)).toMatchObject({
      type: 'error',
      event: 'auth_protocol_error',
    });

    const tooMany = createSession();
    (tooMany.session as any).activeAuthMethod = 'keyboard-interactive';
    (tooMany.session as any).keyboardInteractiveRounds = 8;
    await (tooMany.session as any).handleAuthPacket(60, buildInfoRequest([]));
    expect(tooMany.ws.close).toHaveBeenCalledWith(1011);
    expect(sentJson(tooMany.ws)).toMatchObject({
      type: 'error',
      event: 'auth_interactive_limit',
    });
  });
});
