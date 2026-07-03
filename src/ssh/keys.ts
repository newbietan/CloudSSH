import { SessionKeys } from '../types';
import { concat, encodeString } from './utils';

export class KeyDerivation {
  static async deriveKeys(
    sharedSecret: Uint8Array,
    exchangeHash: Uint8Array,
    sessionID: Uint8Array,
    ivLengthC2S: number = 12,
    ivLengthS2C: number = 12,
    integrityKeyLengthC2S: number = 32,
    integrityKeyLengthS2C: number = 32
  ): Promise<SessionKeys> {
    const ivC2S    = await this.expandKey(sharedSecret, exchangeHash, 'A', sessionID, ivLengthC2S);
    const ivS2C    = await this.expandKey(sharedSecret, exchangeHash, 'B', sessionID, ivLengthS2C);
    const keyC2S   = await this.expandKey(sharedSecret, exchangeHash, 'C', sessionID, 32);
    const keyS2C   = await this.expandKey(sharedSecret, exchangeHash, 'D', sessionID, 32);
    const intKeyC2S = await this.expandKey(sharedSecret, exchangeHash, 'E', sessionID, integrityKeyLengthC2S);
    const intKeyS2C = await this.expandKey(sharedSecret, exchangeHash, 'F', sessionID, integrityKeyLengthS2C);

    return {
      ivClientToServer: ivC2S,
      ivServerToClient: ivS2C,
      encKeyClientToServer: keyC2S,
      encKeyServerToClient: keyS2C,
      integrityKeyC2S: intKeyC2S,
      integrityKeyS2C: intKeyS2C,
      sessionID,
    };
  }

  private static async expandKey(
    K: Uint8Array,
    H: Uint8Array,
    X: string,
    sessionId: Uint8Array,
    needed: number
  ): Promise<Uint8Array> {
    const hashLen = 32;
    const rounds = Math.ceil(needed / hashLen);
    const result = new Uint8Array(needed);
    let offset = 0;

    const XBytes = new TextEncoder().encode(X);

    // K1 = HASH(K || H || X || sessionId)
    let currentHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256',
        concat(K, H, XBytes, sessionId)
      )
    );
    result.set(currentHash.slice(0, Math.min(hashLen, needed)), 0);
    offset += hashLen;

    // For Kn (n > 1): Kn = HASH(K || H || K1 || ... || Kn-1)
    for (let i = 1; i < rounds; i++) {
      const prevKeys = result.slice(0, offset);
      currentHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256',
          concat(K, H, prevKeys)
        )
      );
      const remaining = needed - offset;
      result.set(currentHash.slice(0, Math.min(hashLen, remaining)), offset);
      offset += hashLen;
    }

    return result;
  }
}
