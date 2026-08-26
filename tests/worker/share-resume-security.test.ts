/// <reference lib="es2022" />
import { describe, expect, it, vi } from 'vitest';
import { buildResumeChallengeMessage } from '../../src/share-resume-schema';
import { SSHSessionDO } from '../../src/worker/durable-object';
import { SSHSession } from '../../src/worker/ssh-session';

// 全局 shim 必须幂等安装：并行加载的测试文件（如 session-reattach.test.ts）
// 使用同模式的 globalThis 替换，无守卫时会产生不可预测的双重包装竞态。
const globalShim = globalThis as any;
if (!globalShim.__cloudsshWsTestShimInstalled) {
  globalShim.__cloudsshWsTestShimInstalled = true;

  if (typeof (globalThis as any).WebSocketPair === 'undefined') {
    (globalThis as any).WebSocketPair = class {
      0: any;
      1: any;
      constructor() {
        this[0] = { readyState: 1, send: vi.fn(), close: vi.fn() };
        this[1] = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
          serializeAttachment: vi.fn(),
        };
      }
    } as any;
  }

  const OriginalResponse = globalThis.Response;
  class MockResponse extends OriginalResponse {
    private _mockStatus: number;
    // 基类 Response 要求 webSocket 为必填只读属性；此 Mock 在 101 升级时赋值。
    public webSocket: any;

    constructor(body?: any, init?: any) {
      if (init && init.status === 101) {
        super(null, { status: 200, headers: init.headers });
        this._mockStatus = 101;
        this.webSocket = init.webSocket;
      } else {
        super(body, init);
        this._mockStatus = init?.status ?? 200;
      }
    }

    get status(): number {
      return this._mockStatus;
    }
  }
  globalThis.Response = MockResponse as any;
}

const SESSION_ID = 'share-session:test-0001';
const TOKEN = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6tokenA';
const SHARE_ID = 'share-123';
const SFTP_URL = 'wss://cloudssh.dev/api/ssh/sftp?session=s1&token=tok123';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

interface DeviceKeyPair {
  privateKey: CryptoKey;
  publicKeyB64: string;
}

async function makeDeviceKeyPair(): Promise<DeviceKeyPair> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey('spki', kp.publicKey)) as ArrayBuffer
  );
  return { privateKey: kp.privateKey as CryptoKey, publicKeyB64: toBase64Url(spki) };
}

async function signChallenge(
  privateKey: CryptoKey,
  sessionId: string,
  nonce: string,
  ts: number
): Promise<string> {
  const message = buildResumeChallengeMessage(sessionId, nonce, ts);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(message)
  );
  return toBase64Url(new Uint8Array(sig));
}

let nonceSeq = 0;
function nextNonce(): string {
  nonceSeq += 1;
  return `nonce${String(nonceSeq).padStart(12, '0')}`;
}

/** 构造带有效设备签名的恢复请求。 */
async function signedResumeRequest(
  device: DeviceKeyPair,
  resumeToken: string = TOKEN
): Promise<Request> {
  const nonce = nextNonce();
  const ts = Date.now();
  const sig = await signChallenge(device.privateKey, SESSION_ID, nonce, ts);
  return resumeRequest({
    resume_token: resumeToken,
    did_nonce: nonce,
    did_ts: String(ts),
    did_sig: sig,
  });
}

function createShareSession(expiresAt: number): { session: SSHSession; socket: { close: any } } {
  const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const socket = { close: vi.fn() };
  const session = new SSHSession(
    ws as unknown as WebSocket,
    socket as never,
    {
      host: 'ssh.example.com',
      port: 22,
      username: 'bob',
      password: 'pwd',
      authMethod: 'password',
      sessionPolicy: {
        source: 'share',
        shareId: SHARE_ID,
        shareRef: 'ref-456',
        allowAgent: false,
        allowSftp: true,
        allowMetadataMutation: false,
        allowHostKeyMutation: false,
        allowReconnect: false,
        sessionExpiresAt: expiresAt,
      },
    },
    true,
    false,
    SFTP_URL,
    undefined,
    undefined,
    undefined
  );
  return { session, socket };
}

function createRegularSession(): { session: SSHSession; socket: { close: any } } {
  const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const socket = { close: vi.fn() };
  const session = new SSHSession(
    ws as unknown as WebSocket,
    socket as never,
    { host: 'ssh.example.com', port: 22, username: 'alice', password: 'secret', authMethod: 'password' },
    true,
    false,
    SFTP_URL,
    undefined,
    undefined,
    undefined
  );
  return { session, socket };
}

function createDo(): { doInstance: SSHSessionDO; internal: any } {
  const mockState = {
    storage: { sql: { exec: vi.fn() } },
    acceptWebSocket: vi.fn(),
    waitUntil: vi.fn(),
  };
  const doInstance = new SSHSessionDO(mockState as any, {} as any);
  return { doInstance, internal: doInstance as any };
}

/** 通过真实的异常断线路径把会话置入 detached 状态。 */
async function detachSession(
  doInstance: SSHSessionDO,
  session: SSHSession,
  options: { devicePubKey?: string } = {}
): Promise<void> {
  const internal = doInstance as any;
  (session as any).state = 'ready';
  const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
  internal.sessions.set(ws, session);
  internal.sessionChains.set(ws, [session]);
  internal.sessionToSessionId.set(session, SESSION_ID);
  internal.sessionToResumeToken.set(session, TOKEN);
  if (options.devicePubKey) {
    internal.sessionToDeviceKey.set(session, options.devicePubKey);
  }
  await doInstance.webSocketClose(ws as unknown as WebSocket, 1006, 'Abnormal', false);
}

function resumeRequest(params: Record<string, string> = {}): Request {
  const search = new URLSearchParams({
    session: SESSION_ID,
    resume_token: TOKEN,
    cols: '100',
    rows: '30',
    ...params,
  });
  return new Request(`https://cloudssh.dev/api/ssh?${search.toString()}`, {
    headers: { Upgrade: 'websocket' },
  });
}

describe('SSHSessionDO Share Resume Device-Binding Security', () => {
  it('accepts a valid device-signed resume, rotates the token and restores the SFTP URL', async () => {
    const { doInstance, internal } = createDo();
    const device = await makeDeviceKeyPair();
    const { session } = createShareSession(Date.now() + 600_000);
    await detachSession(doInstance, session, { devicePubKey: device.publicKeyB64 });
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(true);

    const nonce = 'nonce0000000000000001';
    const ts = Date.now();
    const sig = await signChallenge(device.privateKey, SESSION_ID, nonce, ts);
    const res = await doInstance.fetch(resumeRequest({ did_nonce: nonce, did_ts: String(ts), did_sig: sig }));
    expect(res.status).toBe(101);

    // 记录已消费，且 resume token 已轮换
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(false);
    const rotated = internal.sessionToResumeToken.get(session) as string;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(TOKEN);

    // 等待 queueMicrotask 的 reattach 完成，校验 session_resumed 消息内容
    await new Promise((resolve) => setTimeout(resolve, 0));
    const accepted = (doInstance as any).state.acceptWebSocket.mock.calls.at(-1)?.[0];
    expect(accepted).toBeTruthy();
    const resumedFrame = accepted.send.mock.calls
      .map((call: any[]) => String(call[0]))
      .find((text: string) => text.includes('"session_resumed"'));
    expect(resumedFrame).toBeTruthy();
    const parsed = JSON.parse(resumedFrame);
    expect(parsed.resumeToken).toBe(rotated);
    expect(parsed.sftpAttachUrl).toBe(SFTP_URL);
  });

  it('rejects resume without a signature when the share is device-bound', async () => {
    const { doInstance, internal } = createDo();
    const device = await makeDeviceKeyPair();
    const { session } = createShareSession(Date.now() + 600_000);
    await detachSession(doInstance, session, { devicePubKey: device.publicKeyB64 });

    const res = await doInstance.fetch(resumeRequest());
    expect(res.status).toBe(403);
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(true);
  });

  it('rejectes a signature over a tampered challenge message', async () => {
    const { doInstance, internal } = createDo();
    const device = await makeDeviceKeyPair();
    const { session } = createShareSession(Date.now() + 600_000);
    await detachSession(doInstance, session, { devicePubKey: device.publicKeyB64 });

    const nonce = 'nonce0000000000000002';
    const ts = Date.now();
    // 用正确的密钥签名，但消息中的 sessionId 被篡改
    const forged = await signChallenge(device.privateKey, 'share-session:other', nonce, ts);
    const res = await doInstance.fetch(
      resumeRequest({ did_nonce: nonce, did_ts: String(ts), did_sig: forged })
    );
    expect(res.status).toBe(403);
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(true);
  });

  it('burns the nonce even after a failed verification so replays cannot be retried', async () => {
    const { doInstance } = createDo();
    const device = await makeDeviceKeyPair();
    const attacker = await makeDeviceKeyPair();
    const { session } = createShareSession(Date.now() + 600_000);
    await detachSession(doInstance, session, { devicePubKey: device.publicKeyB64 });

    const nonce = 'nonce0000000000000003';
    const ts = Date.now();
    // 第一次：攻击者密钥签名 -> 验签失败，但 nonce 已被消费
    const badSig = await signChallenge(attacker.privateKey, SESSION_ID, nonce, ts);
    const res403a = await doInstance.fetch(
      resumeRequest({ did_nonce: nonce, did_ts: String(ts), did_sig: badSig })
    );
    expect(res403a.status).toBe(403);

    // 第二次：正确密钥 + 同一 nonce -> 仍然拒绝（nonce 已烧毁）
    const goodSig = await signChallenge(device.privateKey, SESSION_ID, nonce, ts);
    const res403b = await doInstance.fetch(
      resumeRequest({ did_nonce: nonce, did_ts: String(ts), did_sig: goodSig })
    );
    expect(res403b.status).toBe(403);

    // 第三次：正确密钥 + 全新 nonce -> 通过
    // 注意：签名与参数必须复用同一个 ts——两次独立取值跨毫秒时验签必然失败（CI 高负载下的偶发源）
    const freshNonce = 'nonce0000000000000004';
    const freshTs = Date.now();
    const freshSig = await signChallenge(device.privateKey, SESSION_ID, freshNonce, freshTs);
    const res101 = await doInstance.fetch(
      resumeRequest({ did_nonce: freshNonce, did_ts: String(freshTs), did_sig: freshSig })
    );
    expect(res101.status).toBe(101);
  });

  it('rejects resumes past the absolute share expiry and destroys the held session', async () => {
    const { doInstance, internal } = createDo();
    const device = await makeDeviceKeyPair();
    const { session, socket } = createShareSession(Date.now() - 1000);
    await detachSession(doInstance, session, { devicePubKey: device.publicKeyB64 });

    const nonce = 'nonce0000000000000005';
    const expiredTs = Date.now();
    const sig = await signChallenge(device.privateKey, SESSION_ID, nonce, expiredTs);
    const res = await doInstance.fetch(
      resumeRequest({ did_nonce: nonce, did_ts: String(expiredTs), did_sig: sig })
    );
    expect(res.status).toBe(403);
    // 到达绝对过期时间：保持的会话立即终结
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(false);
    expect(socket.close).toHaveBeenCalled();
  });

  it('covers detached sessions during share revocation', async () => {
    const { doInstance, internal } = createDo();
    const device = await makeDeviceKeyPair();
    const { session, socket } = createShareSession(Date.now() + 600_000);
    await detachSession(doInstance, session, { devicePubKey: device.publicKeyB64 });

    const revokeRes = await doInstance.fetch(
      new Request('https://internal/internal/revoke-share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareId: SHARE_ID }),
      })
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as { revoked: boolean };
    expect(revokeBody.revoked).toBe(true);
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(false);
    expect(socket.close).toHaveBeenCalled();

    // 撤销后凭旧凭据恢复 -> 404（记录已被销毁）
    const nonce = 'nonce0000000000000006';
    const revokedTs = Date.now();
    const sig = await signChallenge(device.privateKey, SESSION_ID, nonce, revokedTs);
    const res = await doInstance.fetch(
      resumeRequest({ did_nonce: nonce, did_ts: String(revokedTs), did_sig: sig })
    );
    expect(res.status).toBe(404);
  });

  it('tolerates the previous-generation token when a rotation frame is lost across cycles', async () => {
    const { doInstance, internal } = createDo();
    const device = await makeDeviceKeyPair();
    const { session } = createShareSession(Date.now() + 600_000);
    await detachSession(doInstance, session, { devicePubKey: device.publicKeyB64 });

    // 第一周期：携带有效签名的恢复成功并轮换 token
    const first = await doInstance.fetch(await signedResumeRequest(device));
    expect(first.status).toBe(101);
    const rotated = internal.sessionToResumeToken.get(session) as string;
    expect(rotated).not.toBe(TOKEN);

    // 第二周期：恢复后的连接再次异常断开，进入新一轮 detached
    await new Promise((resolve) => setTimeout(resolve, 0));
    const serverWs = (doInstance as any).state.acceptWebSocket.mock.calls.at(-1)[0];
    (session as any).state = 'ready';
    await doInstance.webSocketClose(serverWs, 1006, 'Abnormal', false);
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(true);

    // 完全未知的 token 依旧拒绝（此时记录仍存在 → 403 而非 404）
    expect(
      (await doInstance.fetch(resumeRequest({ resume_token: 'f'.repeat(32) }))).status
    ).toBe(403);

    // 客户端携上一代 token（T1）重试：被容忍并再次轮换（current=T2 → T3；
    // prev 保持为客户端实际持有的 T1，供下一轮再次丢帧时使用）
    const tolerated = await doInstance.fetch(await signedResumeRequest(device, TOKEN));
    expect(tolerated.status).toBe(101);
    expect(internal.sessionToResumeToken.get(session)).not.toBe(rotated);

    // 成功恢复即消费记录：此后任何请求均为 404（单次语义）
    const consumed = await doInstance.fetch(resumeRequest());
    expect(consumed.status).toBe(404);
  });

  it('rejects resume entirely for share sessions without device binding', async () => {
    const { doInstance, internal } = createDo();
    const { session } = createShareSession(Date.now() + 600_000);
    await detachSession(doInstance, session);

    // 严格口径：未绑定设备身份的分享会话不支持断线恢复
    const res = await doInstance.fetch(resumeRequest());
    expect(res.status).toBe(403);
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(true);
  });

  it('does not require device signatures for regular non-share sessions', async () => {
    const { doInstance, internal } = createDo();
    const { session } = createRegularSession();
    await detachSession(doInstance, session);

    const res = await doInstance.fetch(resumeRequest());
    expect(res.status).toBe(101);
    expect(internal.detachedSessions.has(SESSION_ID)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const accepted = (doInstance as any).state.acceptWebSocket.mock.calls.at(-1)[0];
    const resumedFrame = accepted.send.mock.calls
      .map((call: any[]) => String(call[0]))
      .find((text: string) => text.includes('"session_resumed"'));
    const parsed = JSON.parse(resumedFrame);
    expect(parsed.resumeToken).not.toBe(TOKEN);
    expect(parsed.sftpAttachUrl).toBe(SFTP_URL);
  });
});
