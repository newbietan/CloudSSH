export const KEX_ALGORITHM_CURVE25519_SHA256 = 'curve25519-sha256';
export const KEX_ALGORITHM_ECDH_NISTP256 = 'ecdh-sha2-nistp256';

export const SUPPORTED_KEX_ALGORITHMS = [
  KEX_ALGORITHM_CURVE25519_SHA256,
  KEX_ALGORITHM_ECDH_NISTP256,
];

export const SUPPORTED_ENCRYPTION_ALGORITHMS = [
  'aes128-gcm@openssh.com',
  'aes256-gcm@openssh.com',
  'aes128-ctr',
  'aes192-ctr',
  'aes256-ctr',
];

export const SUPPORTED_MAC_ALGORITHMS = [
  'hmac-sha2-256',
  'hmac-sha2-512',
  'hmac-sha1',
];

export interface CipherSpec {
  mode: 'gcm' | 'ctr';
  blockSize: number;
  ivLength: number;
  keyLength: number;
  aead: boolean;
}

export interface MacSpec {
  length: number;
  keyLength: number;
}

const CIPHER_SPECS: Record<string, CipherSpec> = {
  'aes256-gcm@openssh.com': { mode: 'gcm', blockSize: 16, ivLength: 12, keyLength: 32, aead: true },
  'aes128-gcm@openssh.com': { mode: 'gcm', blockSize: 16, ivLength: 12, keyLength: 16, aead: true },
  'aes256-ctr': { mode: 'ctr', blockSize: 16, ivLength: 16, keyLength: 32, aead: false },
  'aes192-ctr': { mode: 'ctr', blockSize: 16, ivLength: 16, keyLength: 24, aead: false },
  'aes128-ctr': { mode: 'ctr', blockSize: 16, ivLength: 16, keyLength: 16, aead: false },
};

const MAC_SPECS: Record<string, MacSpec> = {
  none: { length: 0, keyLength: 32 },
  'hmac-sha1': { length: 20, keyLength: 20 },
  'hmac-sha2-256': { length: 32, keyLength: 32 },
  'hmac-sha2-512': { length: 64, keyLength: 64 },
};

export function isCurve25519KEXAlgorithm(algorithm: string): boolean {
  return algorithm === KEX_ALGORITHM_CURVE25519_SHA256;
}

export function getCipherSpec(algorithm: string): CipherSpec {
  const spec = CIPHER_SPECS[algorithm];
  if (!spec) throw new Error(`Unsupported cipher: ${algorithm}`);
  return spec;
}

export function getMacSpec(algorithm: string): MacSpec {
  const spec = MAC_SPECS[algorithm];
  if (!spec) throw new Error(`Unsupported MAC algorithm: ${algorithm}`);
  return spec;
}

export function getMacAlgorithmsForCipher(cipher: string): string[] {
  if (getCipherSpec(cipher).aead) return ['none'];
  return SUPPORTED_MAC_ALGORITHMS;
}
