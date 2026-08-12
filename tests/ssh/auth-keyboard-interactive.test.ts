import { describe, expect, it } from 'vitest';
import { SSHAuth } from '../../src/ssh/auth';
import { concat, encodeString, encodeUint32, readUint32 } from '../../src/ssh/utils';

function buildInfoRequest(
  name: string,
  instruction: string,
  language: string,
  prompts: Array<{ text: string; echo: boolean }>,
): Uint8Array {
  return concat(
    new Uint8Array([60]),
    encodeString(name),
    encodeString(instruction),
    encodeString(language),
    encodeUint32(prompts.length),
    ...prompts.flatMap(({ text, echo }) => [
      encodeString(text),
      new Uint8Array([echo ? 1 : 0]),
    ]),
  );
}

function readString(
  payload: Uint8Array,
  offset: number,
): { value: string; nextOffset: number } {
  const length = readUint32(payload, offset);
  const valueOffset = offset + 4;
  return {
    value: new TextDecoder().decode(payload.subarray(valueOffset, valueOffset + length)),
    nextOffset: valueOffset + length,
  };
}

describe('SSHAuth keyboard-interactive (RFC 4256)', () => {
  describe('buildNoneAuthRequest', () => {
    it('encodes an RFC 4252 method-discovery request without credentials', () => {
      const packet = SSHAuth.buildNoneAuthRequest('alice');

      expect(packet[0]).toBe(50);
      let offset = 1;
      const username = readString(packet, offset);
      offset = username.nextOffset;
      const service = readString(packet, offset);
      offset = service.nextOffset;
      const method = readString(packet, offset);
      offset = method.nextOffset;

      expect({ username: username.value, service: service.value, method: method.value }).toEqual({
        username: 'alice',
        service: 'ssh-connection',
        method: 'none',
      });
      expect(offset).toBe(packet.length);
      expect(new TextDecoder().decode(packet)).not.toContain('saved-secret');
    });
  });

  describe('buildKeyboardInteractiveAuthRequest', () => {
    it('encodes the username, service, method, language and submethods', () => {
      const packet = SSHAuth.buildKeyboardInteractiveAuthRequest('用户@example');

      expect(packet[0]).toBe(50);
      let offset = 1;
      const username = readString(packet, offset);
      offset = username.nextOffset;
      const service = readString(packet, offset);
      offset = service.nextOffset;
      const method = readString(packet, offset);
      offset = method.nextOffset;
      const language = readString(packet, offset);
      offset = language.nextOffset;
      const submethods = readString(packet, offset);
      offset = submethods.nextOffset;

      expect({
        username: username.value,
        service: service.value,
        method: method.value,
        language: language.value,
        submethods: submethods.value,
      }).toEqual({
        username: '用户@example',
        service: 'ssh-connection',
        method: 'keyboard-interactive',
        language: '',
        submethods: '',
      });
      expect(offset).toBe(packet.length);
    });
  });

  describe('parseKeyboardInteractiveInfoRequest', () => {
    it('parses a single hidden prompt and Unicode server text', () => {
      const packet = buildInfoRequest(
        '双因素认证',
        '请输入密码或动态验证码。',
        'zh-CN',
        [{ text: '密码：', echo: false }],
      );

      expect(SSHAuth.parseKeyboardInteractiveInfoRequest(packet)).toEqual({
        name: '双因素认证',
        instruction: '请输入密码或动态验证码。',
        language: 'zh-CN',
        prompts: [{ text: '密码：', echo: false }],
      });
    });

    it('parses multiple prompts with independent echo flags', () => {
      const packet = buildInfoRequest('Login', 'Complete all fields', '', [
        { text: 'Account: ', echo: true },
        { text: 'Password: ', echo: false },
        { text: 'OTP: ', echo: false },
      ]);

      expect(SSHAuth.parseKeyboardInteractiveInfoRequest(packet).prompts).toEqual([
        { text: 'Account: ', echo: true },
        { text: 'Password: ', echo: false },
        { text: 'OTP: ', echo: false },
      ]);
    });

    it('accepts a zero-prompt informational round', () => {
      const packet = buildInfoRequest('Notice', 'Authentication continues', '', []);

      expect(SSHAuth.parseKeyboardInteractiveInfoRequest(packet)).toEqual({
        name: 'Notice',
        instruction: 'Authentication continues',
        language: '',
        prompts: [],
      });
    });

    it('rejects the wrong message type and empty payloads', () => {
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(new Uint8Array())).toThrow(
        'Unexpected keyboard-interactive message type',
      );
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(new Uint8Array([61]))).toThrow(
        'Unexpected keyboard-interactive message type',
      );
    });

    it('rejects truncated strings, counts and prompt echo flags', () => {
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(new Uint8Array([60, 0, 0]))).toThrow(
        /truncated name length/,
      );

      const truncatedName = concat(
        new Uint8Array([60]),
        encodeUint32(4),
        new TextEncoder().encode('ab'),
      );
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(truncatedName)).toThrow(
        /truncated name$/,
      );

      const missingCount = concat(
        new Uint8Array([60]),
        encodeString(''),
        encodeString(''),
        encodeString(''),
        new Uint8Array([0, 0]),
      );
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(missingCount)).toThrow(
        /truncated prompt count/,
      );

      const missingEcho = concat(
        new Uint8Array([60]),
        encodeString(''),
        encodeString(''),
        encodeString(''),
        encodeUint32(1),
        encodeString('Password: '),
      );
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(missingEcho)).toThrow(
        /missing echo flag/,
      );
    });

    it('rejects invalid UTF-8, invalid booleans and trailing data', () => {
      const invalidUtf8 = concat(
        new Uint8Array([60]),
        encodeString(new Uint8Array([0xc3, 0x28])),
        encodeString(''),
        encodeString(''),
        encodeUint32(0),
      );
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(invalidUtf8)).toThrow(
        /invalid UTF-8 in name/,
      );

      const invalidEcho = buildInfoRequest('', '', '', [{ text: 'Code: ', echo: false }]);
      invalidEcho[invalidEcho.length - 1] = 2;
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(invalidEcho)).toThrow(
        /invalid echo flag/,
      );

      const trailing = concat(buildInfoRequest('', '', '', []), new Uint8Array([0]));
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(trailing)).toThrow(
        /trailing data/,
      );

      const emptyPrompt = buildInfoRequest('', '', '', [{ text: '', echo: false }]);
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(emptyPrompt)).toThrow(
        /prompt 1 is empty/,
      );
    });

    it('rejects excessive prompt counts, field sizes and packet sizes', () => {
      const tooManyPrompts = concat(
        new Uint8Array([60]),
        encodeString(''),
        encodeString(''),
        encodeString(''),
        encodeUint32(33),
      );
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(tooManyPrompts)).toThrow(
        /too many prompts/,
      );

      const oversizedPrompt = buildInfoRequest('', '', '', [
        { text: 'x'.repeat(16 * 1024 + 1), echo: false },
      ]);
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(oversizedPrompt)).toThrow(
        /prompt 1 exceeds size limit/,
      );

      const oversizedPacket = new Uint8Array(256 * 1024 + 1);
      oversizedPacket[0] = 60;
      expect(() => SSHAuth.parseKeyboardInteractiveInfoRequest(oversizedPacket)).toThrow(
        /packet exceeds size limit/,
      );
    });
  });

  describe('buildKeyboardInteractiveInfoResponse', () => {
    it('encodes zero, multiple and Unicode responses', () => {
      const empty = SSHAuth.buildKeyboardInteractiveInfoResponse([]);
      expect(empty).toEqual(new Uint8Array([61, 0, 0, 0, 0]));

      const packet = SSHAuth.buildKeyboardInteractiveInfoResponse(['alice', '密碼🔐']);
      expect(packet[0]).toBe(61);
      expect(readUint32(packet, 1)).toBe(2);

      let offset = 5;
      const first = readString(packet, offset);
      offset = first.nextOffset;
      const second = readString(packet, offset);
      offset = second.nextOffset;
      expect([first.value, second.value]).toEqual(['alice', '密碼🔐']);
      expect(offset).toBe(packet.length);
    });

    it('rejects invalid response counts, values and sizes without exposing values', () => {
      expect(() => SSHAuth.buildKeyboardInteractiveInfoResponse(new Array(33).fill(''))).toThrow(
        /too many responses/,
      );
      expect(() => SSHAuth.buildKeyboardInteractiveInfoResponse([123 as unknown as string])).toThrow(
        /every response must be a string/,
      );
      expect(() => SSHAuth.buildKeyboardInteractiveInfoResponse(['s'.repeat(64 * 1024 + 1)])).toThrow(
        /response exceeds size limit/,
      );
      expect(() => SSHAuth.buildKeyboardInteractiveInfoResponse(new Array(5).fill('s'.repeat(64 * 1024)))).toThrow(
        /packet exceeds size limit/,
      );
    });
  });

  describe('USERAUTH_FAILURE partial success', () => {
    it('parses standards-compliant true and false values', () => {
      const partial = concat(
        new Uint8Array([51]),
        encodeString('publickey,keyboard-interactive'),
        new Uint8Array([1]),
      );
      const notPartial = concat(
        new Uint8Array([51]),
        encodeString('password'),
        new Uint8Array([0]),
      );

      expect(SSHAuth.handleResponse(partial)).toEqual({
        success: false,
        allowedMethods: ['publickey', 'keyboard-interactive'],
        partialSuccess: true,
      });
      expect(SSHAuth.handleResponse(notPartial).partialSuccess).toBe(false);
    });

    it('requires the RFC 4252 partial-success boolean', () => {
      const truncated = concat(new Uint8Array([51]), encodeString('password'));

      expect(() => SSHAuth.handleResponse(truncated)).toThrow(
        /missing partial success flag/,
      );
    });

    it('rejects malformed partial-success flags and trailing bytes', () => {
      const invalidFlag = concat(
        new Uint8Array([51]),
        encodeString('password'),
        new Uint8Array([2]),
      );
      const trailing = concat(
        new Uint8Array([51]),
        encodeString('password'),
        new Uint8Array([0, 0]),
      );

      expect(() => SSHAuth.handleResponse(invalidFlag)).toThrow(/invalid partial success flag/);
      expect(() => SSHAuth.handleResponse(trailing)).toThrow(/trailing data/);
    });
  });
});
