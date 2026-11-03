import { concat, encodeString, encodeUint32, readUint32, toSSHMPInt } from '../../src/ssh/utils';

export function encodeUint64(value: bigint): Uint8Array {
  return concat(encodeUint32(Number(value >> 32n)), encodeUint32(Number(value & 0xffffffffn)));
}

export interface TestSigningKey {
  algorithm: string;
  blob: Uint8Array;
  sign: (data: Uint8Array) => Promise<Uint8Array>;
}

/** Native WebCrypto signatures, encoded independently of the production host-key parser. */
export async function createSigningKey(algorithm = 'ssh-ed25519'): Promise<TestSigningKey> {
  let blob: Uint8Array;
  let sign: (data: Uint8Array) => Promise<Uint8Array>;
  if (algorithm === 'ssh-ed25519') {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    blob = concat(encodeString(algorithm), encodeString(new Uint8Array(
      await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer
    )));
    sign = async (data) => new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, data));
  } else if (algorithm.startsWith('rsa-') || algorithm === 'ssh-rsa') {
    const hash = algorithm === 'rsa-sha2-512' ? 'SHA-512'
      : algorithm === 'ssh-rsa' ? 'SHA-1' : 'SHA-256';
    const pair = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-v1_5', hash, modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    }, true, ['sign', 'verify']) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
    blob = concat(encodeString('ssh-rsa'),
      toSSHMPInt(new Uint8Array(Buffer.from(jwk.e!, 'base64url'))),
      toSSHMPInt(new Uint8Array(Buffer.from(jwk.n!, 'base64url'))));
    sign = async (data) => new Uint8Array(await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', pair.privateKey, data
    ));
  } else {
    const bits = Number(algorithm.split('nistp')[1]);
    const bytes = Math.ceil(bits / 8);
    const hash = bits === 256 ? 'SHA-256' : bits === 384 ? 'SHA-384' : 'SHA-512';
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: `P-${bits}` }, true, ['sign', 'verify']
    ) as CryptoKeyPair;
    blob = concat(encodeString(algorithm), encodeString(`nistp${bits}`),
      encodeString(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer)));
    sign = async (data) => {
      const signature = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash }, pair.privateKey, data
      ));
      return concat(toSSHMPInt(signature.subarray(0, bytes)), toSSHMPInt(signature.subarray(bytes)));
    };
  }
  return {
    algorithm,
    blob,
    sign: async (data) => concat(encodeString(algorithm), encodeString(await sign(data))),
  };
}

let keys: Promise<{ host: TestSigningKey; ca: TestSigningKey }> | undefined;
export function certificateKeys(): Promise<{ host: TestSigningKey; ca: TestSigningKey }> {
  keys ??= Promise.all([createSigningKey(), createSigningKey()])
    .then(([host, ca]) => ({ host, ca }));
  return keys;
}

export interface CertificateOptions {
  nonce?: Uint8Array;
  publicKey?: Uint8Array;
  serial?: bigint;
  type?: number;
  keyId?: string;
  principals?: Uint8Array;
  validAfter?: bigint;
  validBefore?: bigint;
  criticalOptions?: Uint8Array;
  extensions?: Uint8Array;
  reserved?: Uint8Array;
  caPublicKey?: Uint8Array;
  caSignature?: Uint8Array;
}

export async function createHostCertificate(
  options: CertificateOptions = {},
  material?: { host: TestSigningKey; ca: TestSigningKey }
) {
  const { host, ca } = material ?? await certificateKeys();
  const keyType = host.algorithm.startsWith('rsa-') || host.algorithm === 'ssh-rsa'
    ? 'ssh-rsa-cert-v01@openssh.com' : `${host.algorithm}-cert-v01@openssh.com`;
  const fields = host.blob.subarray(4 + readUint32(host.blob, 0));
  const signed = concat(
    encodeString(keyType),
    encodeString(options.nonce ?? new Uint8Array(32).fill(0x42)),
    options.publicKey ? encodeString(options.publicKey) : fields,
    encodeUint64(options.serial ?? 1n),
    encodeUint32(options.type ?? 2),
    encodeString(options.keyId ?? 'cloudssh-protocol-test'),
    encodeString(options.principals ?? encodeString('ssh.example.com')),
    encodeUint64(options.validAfter ?? 0n),
    encodeUint64(options.validBefore ?? 0xffffffffffffffffn),
    encodeString(options.criticalOptions ?? new Uint8Array(0)),
    encodeString(options.extensions ?? new Uint8Array(0)),
    encodeString(options.reserved ?? new Uint8Array(0)),
    encodeString(options.caPublicKey ?? ca.blob)
  );
  const blob = concat(signed, encodeString(options.caSignature ?? await ca.sign(signed)));
  return { blob, signed, host, ca };
}

export async function createUserCertificate(
  options: CertificateOptions = {},
  material?: { host: TestSigningKey; ca: TestSigningKey }
) {
  return createHostCertificate({
    type: 1,
    principals: options.principals ?? encodeString('testuser'),
    ...options,
  }, material);
}

