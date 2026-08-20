import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadKnownFingerprint,
  normalizeChangedHostKeyMessage,
  normalizeVerifiedHostKeyMessage,
  saveKnownFingerprint,
} from '../frontend/src/known-hosts';

const OLD_FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
const NEW_FINGERPRINT = `SHA256:${'B'.repeat(43)}`;

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe('known_hosts 浏览器边界', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('接受签名验证后的首次指纹和完整跳板路由身份', () => {
    expect(
      normalizeVerifiedHostKeyMessage({
        type: 'host_key_verified',
        fingerprint: NEW_FINGERPRINT,
        keyType: 'ssh-ed25519',
        host: 'jump:1@bastion.example.com:22|10.0.0.2',
        displayHost: '10.0.0.2',
        port: 22,
        firstSeen: true,
      })
    ).toEqual({
      fingerprint: NEW_FINGERPRINT,
      keyType: 'ssh-ed25519',
      host: 'jump:1@bastion.example.com:22|10.0.0.2',
      displayHost: '10.0.0.2',
      port: 22,
      firstSeen: true,
    });
  });

  it('仅接受格式完整的指纹变更消息', () => {
    expect(
      normalizeChangedHostKeyMessage({
        fingerprint: NEW_FINGERPRINT,
        expectedFingerprint: OLD_FINGERPRINT,
        keyType: 'ssh-rsa',
        host: 'ssh.example.com',
        port: 2222,
      })
    ).toMatchObject({
      fingerprint: NEW_FINGERPRINT,
      expectedFingerprint: OLD_FINGERPRINT,
      displayHost: 'ssh.example.com',
    });
    expect(
      normalizeChangedHostKeyMessage({
        fingerprint: 'SHA256:invalid',
        expectedFingerprint: OLD_FINGERPRINT,
        keyType: 'ssh-rsa',
        host: 'ssh.example.com',
        port: 2222,
      })
    ).toBeNull();
    expect(
      normalizeChangedHostKeyMessage({
        fingerprint: NEW_FINGERPRINT,
        expectedFingerprint: OLD_FINGERPRINT,
        keyType: 'ssh-rsa',
        host: 'ssh.example.com',
        port: 70000,
      })
    ).toBeNull();
  });

  it('匿名连接以本地记录为准，云端未登录不影响 TOFU 保存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    );

    await saveKnownFingerprint('ssh.example.com', 22, NEW_FINGERPRINT);

    expect(await loadKnownFingerprint('ssh.example.com', 22)).toBe(NEW_FINGERPRINT);
  });

  it('已保存服务器必须成功写入云端后才更新本地记录', async () => {
    localStorage.setItem(
      'cloudssh_known_hosts',
      JSON.stringify({
        'ssh.example.com:22': OLD_FINGERPRINT,
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );

    await expect(
      saveKnownFingerprint('ssh.example.com', 22, NEW_FINGERPRINT, true)
    ).rejects.toThrow('Known-host update failed');

    expect(JSON.parse(localStorage.getItem('cloudssh_known_hosts')!)).toEqual({
      'ssh.example.com:22': OLD_FINGERPRINT,
    });
  });

  it('已保存服务器云端更新成功后同步本地缓存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true }))
    );

    await saveKnownFingerprint('ssh.example.com', 22, NEW_FINGERPRINT, true);

    expect(JSON.parse(localStorage.getItem('cloudssh_known_hosts')!)).toEqual({
      'ssh.example.com:22': NEW_FINGERPRINT,
    });
  });

  it('匿名连接在本地和云端均不可写时报告持久化失败', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('blocked');
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    );

    await expect(saveKnownFingerprint('ssh.example.com', 22, NEW_FINGERPRINT)).rejects.toThrow(
      'Known-host persistence unavailable'
    );
  });
});
