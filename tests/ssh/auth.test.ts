import { describe, it, expect } from 'vitest';
import { SSHAuth } from '../../src/ssh/auth';
import { encodeString, concat, readUint32 } from '../../src/ssh/utils';

describe('SSHAuth', () => {
  describe('buildPasswordAuthRequest', () => {
    it('should build a valid password auth request', () => {
      const username = 'testuser';
      const password = 'testpass';

      const request = SSHAuth.buildPasswordAuthRequest(username, password);

      expect(request[0]).toBe(50); // SSH_MSG_USERAUTH_REQUEST

      let offset = 1;

      const usernameLen = readUint32(request, offset);
      offset += 4;
      const decodedUsername = new TextDecoder().decode(
        request.slice(offset, offset + usernameLen)
      );
      offset += usernameLen;
      expect(decodedUsername).toBe(username);

      const serviceLen = readUint32(request, offset);
      offset += 4;
      const service = new TextDecoder().decode(
        request.slice(offset, offset + serviceLen)
      );
      offset += serviceLen;
      expect(service).toBe('ssh-connection');

      const methodLen = readUint32(request, offset);
      offset += 4;
      const method = new TextDecoder().decode(
        request.slice(offset, offset + methodLen)
      );
      offset += methodLen;
      expect(method).toBe('password');

      expect(request[offset]).toBe(0);
      offset += 1;

      const passwordLen = readUint32(request, offset);
      offset += 4;
      const decodedPassword = new TextDecoder().decode(
        request.slice(offset, offset + passwordLen)
      );
      expect(decodedPassword).toBe(password);
    });

    it('should handle empty password', () => {
      const username = 'testuser';
      const password = '';

      const request = SSHAuth.buildPasswordAuthRequest(username, password);

      // Should still be valid - empty password is allowed in SSH
      expect(request[0]).toBe(50);
      expect(request.length).toBeGreaterThan(0);
    });

    it('should handle special characters in credentials', () => {
      const username = 'user@host';
      const password = 'p@ssw0rd!#$%';

      const request = SSHAuth.buildPasswordAuthRequest(username, password);

      expect(request[0]).toBe(50);

      // Verify username is correctly encoded
      let offset = 1;
      const usernameLen = readUint32(request, offset);
      offset += 4;
      const decodedUsername = new TextDecoder().decode(
        request.slice(offset, offset + usernameLen)
      );
      expect(decodedUsername).toBe(username);
    });
  });

  describe('handleResponse', () => {
    it('should handle USERAUTH_SUCCESS', () => {
      const payload = new Uint8Array([52]); // SSH_MSG_USERAUTH_SUCCESS
      const result = SSHAuth.handleResponse(payload);

      expect(result.success).toBe(true);
      expect(result.allowedMethods).toBeUndefined();
    });

    it('should handle USERAUTH_FAILURE', () => {
      const methods = 'publickey,password';
      const methodsBytes = new TextEncoder().encode(methods);
      const payload = new Uint8Array(5 + methodsBytes.length);
      payload[0] = 51; // SSH_MSG_USERAUTH_FAILURE

      new DataView(payload.buffer).setUint32(1, methodsBytes.length, false);
      payload.set(methodsBytes, 5);

      const result = SSHAuth.handleResponse(payload);

      expect(result.success).toBe(false);
      expect(result.allowedMethods).toEqual(['publickey', 'password']);
    });

    it('should throw on unexpected message type', () => {
      const payload = new Uint8Array([99]);

      expect(() => SSHAuth.handleResponse(payload)).toThrow(
        'Unexpected auth message type: 99'
      );
    });
  });
});
