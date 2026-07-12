import { describe, it, expect } from 'vitest';
import {
  KEX_ALGORITHM_CURVE25519_SHA256,
  KEX_ALGORITHM_ECDH_NISTP256,
  SUPPORTED_KEX_ALGORITHMS,
  SUPPORTED_ENCRYPTION_ALGORITHMS,
  SUPPORTED_MAC_ALGORITHMS,
  isCurve25519KEXAlgorithm,
  getCipherSpec,
  getMacSpec,
  getMacAlgorithmsForCipher,
} from '../../src/ssh/algorithms';

// =====================================================================
// algorithms.test.ts
// ---------------------------------------------------------------
// SSH 算法名常量与查表函数的定义层。项目里多处 KEX/Cipher/MAC
// 协商都依赖这张表，查表抛错或返回错误 spec 会让 SSH 握手静默走错
// 加密通道，所以把每条规则的语义用回归测试固化下来。
// =====================================================================

describe('algorithms — 常量定义', () => {
  it('KEX 算法常量值符合 RFC 8732 / IANA 命名', () => {
    expect(KEX_ALGORITHM_CURVE25519_SHA256).toBe('curve25519-sha256');
    expect(KEX_ALGORITHM_ECDH_NISTP256).toBe('ecdh-sha2-nistp256');
  });

  it('SUPPORTED_KEX_ALGORITHMS 把 curve25519 排在前面（优先协商）', () => {
    expect(SUPPORTED_KEX_ALGORITHMS[0]).toBe(KEX_ALGORITHM_CURVE25519_SHA256);
    expect(SUPPORTED_KEX_ALGORITHMS).toContain(KEX_ALGORITHM_ECDH_NISTP256);
    expect(SUPPORTED_KEX_ALGORITHMS.length).toBeGreaterThanOrEqual(2);
  });

  it('SUPPORTED_ENCRYPTION_ALGORITHMS 包含 GCM 与 CTR 两族', () => {
    expect(SUPPORTED_ENCRYPTION_ALGORITHMS).toContain('aes256-gcm@openssh.com');
    expect(SUPPORTED_ENCRYPTION_ALGORITHMS).toContain('aes128-gcm@openssh.com');
    expect(SUPPORTED_ENCRYPTION_ALGORITHMS).toContain('aes256-ctr');
    expect(SUPPORTED_ENCRYPTION_ALGORITHMS).toContain('aes128-ctr');
  });

  it('SUPPORTED_MAC_ALGORITHMS 覆盖 SHA2 家族', () => {
    expect(SUPPORTED_MAC_ALGORITHMS).toContain('hmac-sha2-256');
    expect(SUPPORTED_MAC_ALGORITHMS).toContain('hmac-sha2-512');
    expect(SUPPORTED_MAC_ALGORITHMS).toContain('hmac-sha1');
  });
});

describe('algorithms — isCurve25519KEXAlgorithm', () => {
  it('识别 curve25519-sha256', () => {
    expect(isCurve25519KEXAlgorithm('curve25519-sha256')).toBe(true);
  });
  it('识别非 curve25519 算法', () => {
    expect(isCurve25519KEXAlgorithm('ecdh-sha2-nistp256')).toBe(false);
  });
  it('不识别大小写变体（SSH 算法名大小写敏感）', () => {
    expect(isCurve25519KEXAlgorithm('Curve25519-SHA256')).toBe(false);
  });
  it('不识别空字符串/未实现算法', () => {
    expect(isCurve25519KEXAlgorithm('')).toBe(false);
    expect(isCurve25519KEXAlgorithm('diffie-hellman-group14-sha256')).toBe(false);
  });
});

describe('algorithms — getCipherSpec', () => {
  it('返回 aes256-gcm@openssh.com 的正确 spec', () => {
    const spec = getCipherSpec('aes256-gcm@openssh.com');
    expect(spec.mode).toBe('gcm');
    expect(spec.blockSize).toBe(16);
    expect(spec.ivLength).toBe(12);
    expect(spec.keyLength).toBe(32);
    expect(spec.aead).toBe(true);
  });
  it('返回 aes128-gcm@openssh.com 的正确 spec', () => {
    const spec = getCipherSpec('aes128-gcm@openssh.com');
    expect(spec.mode).toBe('gcm');
    expect(spec.blockSize).toBe(16);
    expect(spec.ivLength).toBe(12);
    expect(spec.keyLength).toBe(16);
    expect(spec.aead).toBe(true);
  });
  it('返回 aes256-ctr 的正确 spec（CTR 非 AEAD）', () => {
    const spec = getCipherSpec('aes256-ctr');
    expect(spec.mode).toBe('ctr');
    expect(spec.blockSize).toBe(16);
    expect(spec.ivLength).toBe(16);
    expect(spec.keyLength).toBe(32);
    expect(spec.aead).toBe(false);
  });
  it('返回 aes192-ctr 的正确 spec（24 字节密钥）', () => {
    const spec = getCipherSpec('aes192-ctr');
    expect(spec.keyLength).toBe(24);
    expect(spec.aead).toBe(false);
  });
  it('返回 aes128-ctr 的正确 spec', () => {
    const spec = getCipherSpec('aes128-ctr');
    expect(spec.keyLength).toBe(16);
    expect(spec.aead).toBe(false);
  });
  it('对未知 cipher 抛错且消息包含算法名', () => {
    expect(() => getCipherSpec('aes512-ctr')).toThrow(/Unsupported cipher.*aes512-ctr/);
  });
  it('对空字符串抛错', () => {
    expect(() => getCipherSpec('')).toThrow(/Unsupported cipher/);
  });
});

describe('algorithms — getMacSpec', () => {
  it('返回 hmac-sha2-256 的正确 spec（32 字节）', () => {
    const spec = getMacSpec('hmac-sha2-256');
    expect(spec.length).toBe(32);
    expect(spec.keyLength).toBe(32);
  });
  it('返回 hmac-sha2-512 的正确 spec（64 字节）', () => {
    const spec = getMacSpec('hmac-sha2-512');
    expect(spec.length).toBe(64);
    expect(spec.keyLength).toBe(64);
  });
  it('返回 hmac-sha1 的正确 spec（20 字节，遗留兼容）', () => {
    const spec = getMacSpec('hmac-sha1');
    expect(spec.length).toBe(20);
    expect(spec.keyLength).toBe(20);
  });
  it('返回 none 的 spec（AEAD 模式占位）', () => {
    const spec = getMacSpec('none');
    expect(spec.length).toBe(0);
    expect(spec.keyLength).toBe(32);
  });
  it('对未知 MAC 抛错且消息包含算法名', () => {
    expect(() => getMacSpec('hmac-md5')).toThrow(/Unsupported MAC.*hmac-md5/);
  });
  it('对空字符串抛错', () => {
    expect(() => getMacSpec('')).toThrow(/Unsupported MAC/);
  });
});

describe('algorithms — getMacAlgorithmsForCipher', () => {
  it('AEAD cipher (aes256-gcm@openssh.com) 应返回 ["none"]', () => {
    // GCM 自带完整性校验，不需要独立 MAC
    expect(getMacAlgorithmsForCipher('aes256-gcm@openssh.com')).toEqual(['none']);
  });
  it('AEAD cipher (aes128-gcm@openssh.com) 应返回 ["none"]', () => {
    expect(getMacAlgorithmsForCipher('aes128-gcm@openssh.com')).toEqual(['none']);
  });
  it('CTR cipher (aes256-ctr) 应返回完整 MAC 列表（需要独立 MAC）', () => {
    const macs = getMacAlgorithmsForCipher('aes256-ctr');
    expect(macs).toEqual(SUPPORTED_MAC_ALGORITHMS);
    expect(macs).toContain('hmac-sha2-256');
    expect(macs).toContain('hmac-sha2-512');
    expect(macs).not.toContain('none');
  });
  it('CTR cipher (aes128-ctr) 同样返回完整 MAC 列表', () => {
    expect(getMacAlgorithmsForCipher('aes128-ctr')).toEqual(SUPPORTED_MAC_ALGORITHMS);
  });
  it('传入未知 cipher 时通过 getCipherSpec 抛错', () => {
    expect(() => getMacAlgorithmsForCipher('aes512-ctr')).toThrow(/Unsupported cipher/);
  });
});

describe('algorithms — CipherSpec 类型不变性', () => {
  // 把所有支持的 cipher 各跑一遍，固化"必填字段都要存在"这一约束，
  // 防止未来新增 cipher 时漏字段。
  for (const algo of SUPPORTED_ENCRYPTION_ALGORITHMS) {
    it(`${algo} 的 spec 字段都齐全`, () => {
      const spec = getCipherSpec(algo);
      expect(typeof spec.mode).toBe('string');
      expect(['gcm', 'ctr']).toContain(spec.mode);
      expect(typeof spec.blockSize).toBe('number');
      expect(typeof spec.ivLength).toBe('number');
      expect(typeof spec.keyLength).toBe('number');
      expect(typeof spec.aead).toBe('boolean');
    });
  }

  // GCM 必须是 AEAD=true，CTR 必须是 AEAD=false —— 这两条不变性一旦错位
  // 会直接导致 MAC 校验逻辑走错分支（GCM 漏校验 MAC，或 CTR 多挂一个
  // 不存在的 AEAD tag 处理），属于协议级灾难，单独固定。
  it('所有 GCM cipher 的 aead 必为 true', () => {
    for (const algo of SUPPORTED_ENCRYPTION_ALGORITHMS) {
      if (algo.includes('gcm')) {
        expect(getCipherSpec(algo).aead, algo).toBe(true);
      }
    }
  });
  it('所有 CTR cipher 的 aead 必为 false', () => {
    for (const algo of SUPPORTED_ENCRYPTION_ALGORITHMS) {
      if (algo.includes('ctr')) {
        expect(getCipherSpec(algo).aead, algo).toBe(false);
      }
    }
  });
});
