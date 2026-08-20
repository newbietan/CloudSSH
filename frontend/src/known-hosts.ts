const STORAGE_KEY = 'cloudssh_known_hosts';
const SHA256_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_HOST_IDENTITY_LENGTH = 2048;
const MAX_KEY_TYPE_LENGTH = 128;

export interface VerifiedHostKeyMessage {
  fingerprint: string;
  keyType: string;
  host: string;
  port: number;
  displayHost: string;
  firstSeen: boolean;
}

export interface ChangedHostKeyMessage extends Omit<VerifiedHostKeyMessage, 'firstSeen'> {
  expectedFingerprint: string;
}

function normalizeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function normalizeFingerprint(value: unknown): string | null {
  const fingerprint = normalizeString(value, 80);
  return fingerprint && SHA256_FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : null;
}

function normalizePort(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
    ? Number(value)
    : null;
}

function normalizeHostKeyBase(message: unknown): Omit<VerifiedHostKeyMessage, 'firstSeen'> | null {
  if (!message || typeof message !== 'object') return null;
  const input = message as Record<string, unknown>;
  const fingerprint = normalizeFingerprint(input.fingerprint);
  const host = normalizeString(input.host, MAX_HOST_IDENTITY_LENGTH);
  const port = normalizePort(input.port);
  const keyType = normalizeString(input.keyType, MAX_KEY_TYPE_LENGTH);
  const displayHost = normalizeString(input.displayHost, MAX_HOST_IDENTITY_LENGTH) ?? host;
  if (!fingerprint || !host || !port || !keyType || !displayHost) return null;
  return { fingerprint, host, port, keyType, displayHost };
}

export function normalizeVerifiedHostKeyMessage(message: unknown): VerifiedHostKeyMessage | null {
  const base = normalizeHostKeyBase(message);
  if (!base || typeof (message as Record<string, unknown>).firstSeen !== 'boolean') return null;
  return { ...base, firstSeen: (message as Record<string, unknown>).firstSeen as boolean };
}

export function normalizeChangedHostKeyMessage(message: unknown): ChangedHostKeyMessage | null {
  const base = normalizeHostKeyBase(message);
  if (!base) return null;
  const expectedFingerprint = normalizeFingerprint(
    (message as Record<string, unknown>).expectedFingerprint
  );
  return expectedFingerprint ? { ...base, expectedFingerprint } : null;
}

function saveLocalFingerprint(host: string, port: number, fingerprint: string): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[`${host}:${port}`] = fingerprint;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存已通过服务端签名验证的主机指纹。
 * 已保存服务器依赖云端记录生成下一次连接配置，因此 requireCloud=true 时失败必须上抛。
 */
export async function saveKnownFingerprint(
  host: string,
  port: number,
  fingerprint: string,
  requireCloud = false
): Promise<void> {
  const localSaved = requireCloud ? false : saveLocalFingerprint(host, port, fingerprint);
  let cloudSaved = false;

  try {
    const response = await fetch('/api/known-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, fingerprint }),
    });
    cloudSaved = response.ok;
    if (!response.ok && requireCloud)
      throw new Error(`Known-host update failed (${response.status})`);
  } catch (error) {
    if (requireCloud) throw error;
  }

  if (requireCloud && cloudSaved) {
    saveLocalFingerprint(host, port, fingerprint);
    return;
  }
  if (!localSaved && !cloudSaved) {
    throw new Error('Known-host persistence unavailable');
  }
}

/** 优先加载登录用户的云端指纹，未登录时回退到本地 TOFU 记录。 */
export async function loadKnownFingerprint(host: string, port: number): Promise<string | null> {
  try {
    const response = await fetch(`/api/known-hosts?host=${encodeURIComponent(host)}&port=${port}`);
    if (response.ok) {
      const data = (await response.json()) as { fingerprint: string | null };
      const fingerprint = normalizeFingerprint(data.fingerprint);
      if (fingerprint) return fingerprint;
    }
  } catch {
    /* 未登录或网络错误 */
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const map = JSON.parse(raw) as Record<string, string>;
      return normalizeFingerprint(map[`${host}:${port}`]);
    }
  } catch {
    /* 本地存储不可用或数据损坏 */
  }

  return null;
}
