/**
 * Cloudflare Zero Trust SSH CA 客户端模块。
 * 在浏览器端生成临时 ECDSA P-256 密钥对，并调用 /api/cf-ssh-ca/sign 申请短期用户证书。
 */

function encodeUint32(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (n >> 24) & 0xff;
  buf[1] = (n >> 16) & 0xff;
  buf[2] = (n >> 8) & 0xff;
  buf[3] = n & 0xff;
  return buf;
}

function encodeString(val: string | Uint8Array): Uint8Array {
  const bytes = typeof val === 'string' ? new TextEncoder().encode(val) : val;
  const len = encodeUint32(bytes.length);
  const out = new Uint8Array(4 + bytes.length);
  out.set(len, 0);
  out.set(bytes, 4);
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const res = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    res.set(a, off);
    off += a.length;
  }
  return res;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export interface GeneratedKeyPair {
  privateKeyPEM: string;
  publicKeyOpenSSH: string;
}

/**
 * 在浏览器本地生成用于本次连接的 ECDSA P-256 临时密钥对。
 * 私钥留存于内存中，连接结束即销毁。
 */
export async function generateEcdsaKeyPair(): Promise<GeneratedKeyPair> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  )) as CryptoKeyPair;

  // 1. 导出公钥并格式化为 OpenSSH 格式
  const rawPoint = new Uint8Array(
    (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer
  );
  const pubBlob = concatBytes(
    encodeString('ecdsa-sha2-nistp256'),
    encodeString('nistp256'),
    encodeString(rawPoint)
  );
  const publicKeyOpenSSH = `ecdsa-sha2-nistp256 ${toBase64(pubBlob)} cf-ssh-ca-session`;

  // 2. 导出私钥并格式化为 PKCS#8 PEM
  const pkcs8Der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)) as ArrayBuffer
  );
  const b64 = toBase64(pkcs8Der);
  // 每 64 字符换行
  const chunks = b64.match(/.{1,64}/g) || [b64];
  const privateKeyPEM = `-----BEGIN PRIVATE KEY-----\n${chunks.join('\n')}\n-----END PRIVATE KEY-----`;

  return {
    privateKeyPEM,
    publicKeyOpenSSH,
  };
}

export interface MintedSshCredentials {
  privateKey: string;
  certificate: string;
  expiresAt?: string;
}

/**
 * 向 /api/cf-ssh-ca/sign 申请 Cloudflare SSH CA 签发的短期证书。
 */
export async function requestCloudflareSshCertificate(
  teamName: string,
  token?: string
): Promise<MintedSshCredentials> {
  const { privateKeyPEM, publicKeyOpenSSH } = await generateEcdsaKeyPair();

  let resp: Response;
  try {
    resp = await fetch('/api/cf-ssh-ca/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        teamName: teamName.trim(),
        publicKey: publicKeyOpenSSH,
        token: token ? token.trim() : undefined,
      }),
    });
  } catch (err: any) {
    throw new Error(`连接证书签发服务失败: ${err.message || String(err)}`);
  }

  if (!resp.ok) {
    const errorJson = (await resp.json().catch(() => ({}))) as any;
    const msg = errorJson.error || `申请证书失败 (HTTP ${resp.status})`;
    throw new Error(msg);
  }

  const data = (await resp.json()) as any;
  if (!data || typeof data.certificate !== 'string') {
    throw new Error('未获取到有效的 Cloudflare SSH 证书');
  }

  return {
    privateKey: privateKeyPEM,
    certificate: data.certificate,
    expiresAt: data.expires_at,
  };
}
