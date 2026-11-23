import { afterEach, describe, expect, it, vi } from 'vitest';
import { ED25519_HOST_CERTIFICATE_ALGORITHM as CERT } from '../../src/ssh/algorithms';
import { fingerprintHostKey } from '../../src/ssh/host-key';
import { KEXInitBuilder, parseKEXInit } from '../../src/ssh/kex';
import { Curve25519KeyExchange } from '../../src/ssh/kex-curve25519';
import { concat, encodeString } from '../../src/ssh/utils';
import type { SSHConnectionConfig } from '../../src/types';
import { SSHSession } from '../../src/worker/ssh-session';
import { certificateKeys, createHostCertificate, createSigningKey, type TestSigningKey } from '../ssh/host-certificate-fixture';

const sessions: SSHSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close(true);
  vi.restoreAllMocks();
});

function serverOffer(hostAlgorithms = [CERT]) {
  const client = parseKEXInit(KEXInitBuilder.build());
  return concat(new Uint8Array([20]), new Uint8Array(16), ...[
    'curve25519-sha256,ecdh-sha2-nistp256', hostAlgorithms.join(','),
    client.encryptionC2S.join(','), client.encryptionS2C.join(','),
    client.macC2S.join(','), client.macS2C.join(','), 'none', 'none', '', '',
  ].map(encodeString), new Uint8Array(5));
}

function createSession(config: Partial<SSHConnectionConfig> = {}) {
  const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const writes: Uint8Array[] = [];
  const socket = {
    close: vi.fn(),
    writable: new WritableStream<Uint8Array>({ write: (bytes) => { writes.push(bytes); } }),
  };
  const session = new SSHSession(ws as unknown as WebSocket, socket, {
    host: 'ssh.example.com', port: 2222, username: 'redacted-test-user', password: '',
    authMethod: 'none', ...config,
  });
  sessions.push(session);
  const internal = session as any;
  internal.state = 'kex';
  internal.transport.handleVersionExchange('SSH-2.0-instabox\r\n');
  return { session, internal, ws, socket, writes };
}

function messages(context: ReturnType<typeof createSession>) {
  return context.ws.send.mock.calls.map(([value]) => JSON.parse(value as string));
}

async function start(context: ReturnType<typeof createSession>, offer = serverOffer()) {
  await context.internal.startKEX();
  await context.internal.handleKEXPacket(20, offer);
}

async function reply(
  context: ReturnType<typeof createSession>,
  hostKeyBlob: Uint8Array,
  signer: TestSigningKey,
  hashHostKeyBlob = hostKeyBlob
) {
  const { internal } = context;
  const serverPair = await Curve25519KeyExchange.generateKeyPair();
  const serverPublicKey = await Curve25519KeyExchange.exportRawPublicKey(serverPair);
  const secret = await Curve25519KeyExchange.computeSharedSecret(serverPair.privateKey, internal.kexRawPublicKey);
  const hash = await Curve25519KeyExchange.computeExchangeHash(
    internal.transport.getLocalVersion(), internal.transport.getRemoteVersion(),
    internal.kexInitLocal, internal.kexInitRemote, hashHostKeyBlob,
    internal.kexRawPublicKey, serverPublicKey, secret
  );
  return concat(new Uint8Array([31]), encodeString(hostKeyBlob),
    encodeString(serverPublicKey), encodeString(await signer.sign(hash)));
}

async function acceptCertificate(context: ReturnType<typeof createSession>) {
  const cert = await createHostCertificate();
  await start(context);
  await context.internal.handleKEXPacket(31, await reply(context, cert.blob, cert.host));
  return cert;
}

describe('SSHSession host certificate compatibility (#169)', () => {
  it('completes native certificate KEX, NEWKEYS and none authentication before opening a shell', async () => {
    const context = createSession();
    const cert = await acceptCertificate(context);
    expect(context.internal.negotiatedHostKeyAlgorithm).toBe(CERT);
    expect(context.internal.derivedKeys).not.toBeNull();
    expect(context.internal.hostKeyFingerprint).toBe(await fingerprintHostKey(cert.host.blob));
    expect(messages(context)).toContainEqual(expect.objectContaining({
      type: 'host_key_verified', host: 'ssh.example.com', port: 2222, keyType: CERT,
    }));
    expect(messages(context)).toContainEqual(expect.objectContaining({ event: 'host_key_certificate_tofu' }));
    expect(context.ws.close).not.toHaveBeenCalled();

    await context.internal.handleKEXPacket(21, new Uint8Array([21]));
    expect(context.internal.state).toBe('auth');
    expect(context.internal.encryptCipher).not.toBeNull();
    const send = vi.spyOn(context.internal, 'sendEncrypted');
    await context.internal.handleAuthPacket(6,
      concat(new Uint8Array([6]), encodeString('ssh-userauth')));
    expect(send).toHaveBeenCalledWith(concat(new Uint8Array([50]),
      encodeString('redacted-test-user'), encodeString('ssh-connection'), encodeString('none')));
    await context.internal.handleAuthPacket(52, new Uint8Array([52]));
    expect(messages(context)).toContainEqual(expect.objectContaining({ event: 'auth_success' }));
    expect(context.internal.state).toBe('shell');
  });

  it.each(['rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'])('completes a %s certificate KEX', async (algorithm) => {
    const { ca } = await certificateKeys();
    const host = await createSigningKey(algorithm);
    const cert = await createHostCertificate({}, { host, ca });
    const context = createSession();
    await start(context, serverOffer([`${algorithm}-cert-v01@openssh.com`]));
    await context.internal.handleKEXPacket(31, await reply(context, cert.blob, host));
    expect(context.internal.derivedKeys).not.toBeNull();
    expect(context.internal.hostKeyFingerprint).toBe(await fingerprintHostKey(host.blob));
    expect(context.ws.close).not.toHaveBeenCalled();
  });

  it('uses the existing raw-key fingerprint and exact jump-route identity for certificate TOFU', async () => {
    const { host } = await certificateKeys();
    const fingerprint = await fingerprintHostKey(host.blob);
    const context = createSession({
      expectedFingerprint: fingerprint,
      knownHostIdentity: 'jump:1@bastion.example.com:22|ssh.example.com',
    });
    await acceptCertificate(context);
    expect(messages(context)).toContainEqual(expect.objectContaining({ event: 'host_key_accepted' }));
    expect(messages(context).some((message) => message.type === 'host_key_changed')).toBe(false);
    expect(messages(context).some((message) => message.type === 'host_key_verified')).toBe(false);
    expect(context.ws.close).not.toHaveBeenCalled();
  });

  it('does not save a certificate CA key as the host fingerprint', async () => {
    const context = createSession({ knownHostIdentity: 'route-scoped-identity' });
    const cert = await acceptCertificate(context);
    const message = messages(context).find((item) => item.type === 'host_key_verified');
    expect(message.host).toBe('route-scoped-identity');
    expect(message.fingerprint).toBe(await fingerprintHostKey(cert.host.blob));
    expect(message.fingerprint).not.toBe(await fingerprintHostKey(cert.ca.blob));
  });

  it('rejects a KEX signature computed with the raw key substituted into the certificate transcript', async () => {
    const context = createSession();
    const cert = await createHostCertificate();
    await start(context);
    const badReply = await reply(context, cert.blob, cert.host, cert.host.blob);
    await context.internal.handleKEXPacket(31, badReply);
    expect(context.ws.close).toHaveBeenCalledWith(1000);
    expect(messages(context)).toContainEqual(expect.objectContaining({ event: 'host_key_invalid' }));
    expect(messages(context).some((message) => message.type === 'host_key_verified')).toBe(false);
    expect(context.internal.derivedKeys).toBeNull();
  });

  it.each(['first seen', 'known fingerprint', 'verifier failure', 'rekey'])('rejects an unverified raw host key before trust or NEWKEYS: %s', async (stage) => {
    const { host, ca } = await certificateKeys();
    const context = createSession(stage === 'known fingerprint'
      ? { expectedFingerprint: await fingerprintHostKey(host.blob) } : {});
    const offer = serverOffer(['ssh-ed25519']);
    await start(context, offer);
    if (stage === 'rekey') {
      await context.internal.handleKEXPacket(31, await reply(context, host.blob, host));
      await context.internal.handleKEXPacket(21, new Uint8Array([21]));
      context.internal.state = 'ready';
      await context.internal.handleServerRekeyInit(offer);
    }
    context.ws.send.mockClear();
    const packet = await reply(context, host.blob, ca);
    if (stage === 'verifier failure') vi.spyOn(crypto.subtle, 'verify').mockRejectedValueOnce(new Error('verify failed'));
    if (stage === 'rekey') await context.internal.handleRekeyPacket(31, packet);
    else await context.internal.handleKEXPacket(31, packet);
    expect(context.ws.close).toHaveBeenCalledWith(1000);
    expect(context.socket.close).toHaveBeenCalledOnce();
    expect(messages(context)).toContainEqual(expect.objectContaining({ event: 'host_key_invalid' }));
    expect(messages(context).some(m => m.type === 'host_key_verified' || m.type === 'host_key_changed' || m.event === 'host_key_accepted')).toBe(false);
    if (stage !== 'rekey') expect(context.internal.derivedKeys).toBeNull();
  });

  it('rejects both invalid certificate signatures and invalid KEX signatures', async () => {
    for (const badCertificate of [false, true]) {
      const context = createSession();
      const cert = await createHostCertificate(badCertificate ? { caSignature:
        concat(encodeString('ssh-ed25519'), encodeString(new Uint8Array(64))) } : {});
      await start(context);
      const packet = await reply(context, cert.blob, badCertificate ? cert.host : cert.ca);
      await context.internal.handleKEXPacket(31, packet);
      expect(context.ws.close).toHaveBeenCalledWith(1000);
      expect(context.socket.close).toHaveBeenCalledOnce();
      expect(messages(context).some((message) => message.type === 'host_key_verified')).toBe(false);
      expect(context.internal.derivedKeys).toBeNull();
    }
  });

  it('rejects a certificate reply when raw Ed25519 was selected', async () => {
    const context = createSession();
    const cert = await createHostCertificate();
    await start(context, serverOffer(['ssh-ed25519']));
    await context.internal.handleKEXPacket(31, await reply(context, cert.blob, cert.host));
    expect(context.ws.close).toHaveBeenCalledWith(1000);
    expect(messages(context)).toContainEqual(expect.objectContaining({ event: 'host_key_invalid' }));
  });

  it('preserves the explicit changed-key confirmation path for normal sessions', async () => {
    const previous = `SHA256:${'A'.repeat(43)}`;
    const context = createSession({ expectedFingerprint: previous, knownHostIdentity: 'exact-route' });
    await acceptCertificate(context);
    expect(context.ws.close).toHaveBeenCalledWith(1000);
    expect(messages(context)).toContainEqual(expect.objectContaining({
      type: 'host_key_changed', expectedFingerprint: previous, host: 'exact-route', keyType: CERT,
    }));
    expect(messages(context).some((message) => message.type === 'host_key_verified')).toBe(false);
  });

  it('shared sessions can use a pinned certificate subject but cannot replace it', async () => {
    const { host } = await certificateKeys();
    const policy = {
      source: 'share' as const, shareId: 'share-test', shareRef: 'opaque-test',
      allowAgent: false as const, allowSftp: false, allowMetadataMutation: false as const,
      allowHostKeyMutation: false as const, allowReconnect: false as const,
      sessionExpiresAt: Date.now() + 60_000,
    };
    for (const matches of [true, false]) {
      const context = createSession({
        sessionPolicy: policy,
        expectedFingerprint: matches ? await fingerprintHostKey(host.blob) : `SHA256:${'A'.repeat(43)}`,
      });
      await acceptCertificate(context);
      expect(messages(context).some((message) => message.type === 'host_key_changed')).toBe(false);
      expect(messages(context).some((message) => message.type === 'host_key_verified')).toBe(false);
      expect(context.internal.derivedKeys !== null).toBe(matches);
      expect(context.ws.close.mock.calls.length > 0).toBe(!matches);
    }
  });

  it.each([false, true])('closes an unsupported host-key proposal before ECDH_INIT (rekey=%s)', async (rekey) => {
    const context = createSession();
    if (rekey) {
      await acceptCertificate(context);
      await context.internal.handleKEXPacket(21, new Uint8Array([21]));
      context.internal.state = 'ready';
    }
    const sendInitial = vi.spyOn(context.internal, 'sendKEXECDHInit');
    const sendRekey = vi.spyOn(context.internal, 'sendRekeyECDHInit');
    const offer = serverOffer(['ssh-dss-cert-v01@openssh.com']);
    if (rekey) {
      await context.internal.handleServerRekeyInit(offer);
    } else {
      await start(context, offer);
    }
    expect(sendInitial).not.toHaveBeenCalled();
    expect(sendRekey).not.toHaveBeenCalled();
    expect(context.ws.close).toHaveBeenCalledWith(1000);
    expect(messages(context)).toContainEqual(expect.objectContaining({
      event: 'algorithm_error', params: {
        message: expect.stringContaining('No common host key algorithm'),
      },
    }));
    expect(context.internal.closed).toBe(true);
  });

  it('accepts a renewed certificate during rekey only when its underlying key stays pinned', async () => {
    const context = createSession();
    const original = await acceptCertificate(context);
    await context.internal.handleKEXPacket(21, new Uint8Array([21]));
    context.internal.state = 'ready';
    const publishCount = messages(context).filter((item) => item.type === 'host_key_verified').length;
    const renewed = await createHostCertificate({ serial: 2n, keyId: 'renewal', nonce: new Uint8Array([1]) });
    await context.internal.handleServerRekeyInit(serverOffer());
    expect(context.internal.isRekeying).toBe(true);
    await context.internal.handleRekeyPacket(31, await reply(context, renewed.blob, renewed.host));
    await context.internal.handleRekeyPacket(21, new Uint8Array([21]));
    expect(context.internal.state).toBe('ready');
    expect(context.internal.isRekeying).toBe(false);
    expect(context.internal.acceptedHostKeyFingerprint).toBe(await fingerprintHostKey(original.host.blob));
    expect(messages(context).filter((item) => item.type === 'host_key_verified')).toHaveLength(publishCount);
    expect(context.ws.close).not.toHaveBeenCalled();
  });

  it('closes rather than silently accepting a different valid host key during rekey', async () => {
    const context = createSession();
    await acceptCertificate(context);
    await context.internal.handleKEXPacket(21, new Uint8Array([21]));
    context.internal.state = 'ready';
    const { ca } = await certificateKeys();
    const changed = await createHostCertificate({}, { host: await createSigningKey(), ca });
    await context.internal.handleServerRekeyInit(serverOffer());
    await context.internal.handleRekeyPacket(31, await reply(context, changed.blob, changed.host));
    expect(context.ws.close).toHaveBeenCalledWith(1000);
    expect(context.internal.closed).toBe(true);
    expect(messages(context)).toContainEqual(expect.objectContaining({ event: 'host_key_changed' }));
    expect(messages(context).some((item) => item.type === 'host_key_changed')).toBe(false);
  });

  it('does not publish late certificate verification after the session has closed', async () => {
    const context = createSession();
    const cert = await createHostCertificate();
    await start(context);
    const packet = await reply(context, cert.blob, cert.host);
    vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce(async () => {
      context.session.close(true);
      return true;
    });
    await context.internal.handleKEXPacket(31, packet);
    expect(messages(context).some((item) => item.type === 'host_key_verified')).toBe(false);
    expect(context.internal.derivedKeys).toBeNull();
  });
});
