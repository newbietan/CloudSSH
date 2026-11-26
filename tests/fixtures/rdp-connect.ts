import { createDecipheriv, hkdfSync, webcrypto } from 'node:crypto';
import type { RdpLogin } from '../../src/rdp-schema';
import { importRdpConnectKey, sealRdpLogin, type RdpConnectGrant, type RdpLoginContext, type RdpLoginEnvelope } from '../../src/worker/rdp-connect-crypto';

const curve = { name: 'ECDH', namedCurve: 'P-256' };
export async function testRdpConnectKey() {
  const keys = await webcrypto.subtle.generateKey(curve, false, ['deriveBits']);
  return { privateKey: keys.privateKey, clientKey: Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url') };
}

export async function testRdpGrant(key: unknown, context: RdpLoginContext, login: RdpLogin): Promise<RdpConnectGrant> {
  const recipient = typeof key === 'string' ? await importRdpConnectKey(key) : null;
  if (!recipient) throw new Error('fixture expected a valid ephemeral client key');
  return { ticket: context.ticket, revision: context.revision, loginEnvelope: await sealRdpLogin(login, recipient, context) };
}

/** Independent Node HKDF/AEAD oracle; the actual browser implementation is also exercised in E2E. */
export async function openTestRdpEnvelope(box: RdpLoginEnvelope, recipient: Awaited<ReturnType<typeof testRdpConnectKey>>, context: RdpLoginContext) {
  const sender = await webcrypto.subtle.importKey('raw', Buffer.from(box.senderKey, 'base64url'), curve, false, []);
  const secret = new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: sender }, recipient.privateKey, 256));
  const aad = Buffer.from(JSON.stringify(['cloudssh-rdp-login-v1', context.origin, context.profile, context.revision,
    context.transport, context.ticket, recipient.clientKey, box.senderKey]));
  const key = Buffer.from(hkdfSync('sha256', secret, context.ticket, aad, 32));
  const data = Buffer.from(box.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
  decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8')) as RdpLogin;
}
