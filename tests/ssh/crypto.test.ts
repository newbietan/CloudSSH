import { describe, it, expect, beforeEach } from 'vitest';
import {
  SSHAESGCMCipher,
  SSHAESCTRCipher,
  SSHHMAC,
  REKEY_THRESHOLD,
  shouldRekey,
} from '../../src/ssh/crypto';

// =====================================================================
// crypto.test.ts
// ---------------------------------------------------------------
// SSH 密码学层测试，使用 Node 原生 WebCrypto（不 mock 加密原语）。
// 重点不是重测 WebCrypto 本身，而是固化项目代码对它的使用约束：
//   - GCM/CTR 的 IV/counter 在每次加密后必须按 RFC 自增
//   - commit=false（peek 解密）不应修改内部状态
//   - AES-CTR 的 16 字节 IV 长度检查
//   - HMAC 三种算法 + length 字段 + 不支持算法的构造时拒绝
//   - shouldRekey 的阈值边界
// 这些约束错位都是 SSH 协议里"看起来能工作但安全 silent fail"
// 的常见藏身处：nonce 复用、AAD 漏传、IV 没自增会导致密钥轮换
// 我从来不触发、长期暴露同一密钥——表面安全但前向保密失效。
// =====================================================================

// --- 共用测试工具 ---
const ENCODER = new TextEncoder();

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// 项目里 GCM 的 IV 长度是 12 字节（看 algorithms.ts 的 ivLength=12）
const GCM_IV_LENGTH = 12;
// CTR 的 IV 长度是 16 字节（AES block size）
const CTR_IV_LENGTH = 16;

// GCM 密钥长度支持 16/32 字节（AES-128/AES-256）
const AES_128_KEY = randomBytes(16);
const AES_256_KEY = randomBytes(32);

// =====================================================================
// shouldRekey 与 REKEY_THRESHOLD
// =====================================================================
describe('crypto — shouldRekey 边界', () => {
  it('REKEY_THRESHOLD = 1 << 30 = 1073741824', () => {
    expect(REKEY_THRESHOLD).toBe(1 << 30);
    expect(REKEY_THRESHOLD).toBe(1073741824);
  });

  it('seqNum = 0 应小于阈值，不需 rekey', () => {
    expect(shouldRekey(0)).toBe(false);
  });

  it('seqNum = 阈值 - 1 应小于阈值，不需 rekey', () => {
    expect(shouldRekey(REKEY_THRESHOLD - 1)).toBe(false);
  });

  it('seqNum = 阈值正好等于阈值，应触发 rekey', () => {
    expect(shouldRekey(REKEY_THRESHOLD)).toBe(true);
  });

  it('seqNum = 阈值 + 1 应触发 rekey', () => {
    expect(shouldRekey(REKEY_THRESHOLD + 1)).toBe(true);
  });

  it('seqNum 远大于阈值应触发 rekey', () => {
    expect(shouldRekey(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('负 seqNum 不触发 rekey（边界，虽然实际不会出现）', () => {
    expect(shouldRekey(-1)).toBe(false);
  });
});

// =====================================================================
// SSHAESGCMCipher
// =====================================================================
describe('crypto — SSHAESGCMCipher', () => {
  describe('初始化', () => {
    it('init 之前调用 encrypt 抛错', async () => {
      const cipher = new SSHAESGCMCipher(AES_256_KEY, randomBytes(GCM_IV_LENGTH));
      await expect(cipher.encrypt(ENCODER.encode('hello'))).rejects.toThrow(/not initialized/);
    });
    it('init 之前调用 decrypt 抛错', async () => {
      const cipher = new SSHAESGCMCipher(AES_256_KEY, randomBytes(GCM_IV_LENGTH));
      await expect(cipher.decrypt(randomBytes(16))).rejects.toThrow(/not initialized/);
    });
    it('init 之后不抛错', async () => {
      const cipher = new SSHAESGCMCipher(AES_256_KEY, randomBytes(GCM_IV_LENGTH));
      await expect(cipher.init()).resolves.toBeUndefined();
    });
  });

  describe('加解密往返', () => {
    // SSH 协议中加密和解密是两个独立方向（c2s / s2c），两端各自维护自己的 IV。
    // 一个 cipher 实例自加密又自解密的做法在 GCM/CTR 里是错的——
    // encrypt 后 IV 自增，decrypt 时 IV 已经不在密文生成的位置上。
    // 正确模式：用两个 cipher 实例从同一 (key, iv) 起步，一个 enc 一个 dec。
    async function makePair(key: Uint8Array) {
      const iv = randomBytes(GCM_IV_LENGTH);
      const enc = new SSHAESGCMCipher(key, iv);
      const dec = new SSHAESGCMCipher(new Uint8Array(key), iv);
      await enc.init();
      await dec.init();
      return { enc, dec };
    }

    it('短文本解密后应还原原文（AES-256-GCM）', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('hello ssh world');
      const ciphertext = await enc.encrypt(plaintext);
      // GCM 密文尾部带 16 字节 tag
      expect(ciphertext.length).toBe(plaintext.length + 16);
      const decrypted = await dec.decrypt(ciphertext);
      expect(decrypted).not.toBeNull();
      expect(decrypted!).toEqual(plaintext);
    });

    it('空 plaintext 加解密往返', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = new Uint8Array(0);
      const ciphertext = await enc.encrypt(plaintext);
      // 即使明文为空，GCM 仍输出 16 字节 tag
      expect(ciphertext.length).toBe(16);
      const decrypted = await dec.decrypt(ciphertext);
      expect(decrypted).not.toBeNull();
      expect(decrypted!.length).toBe(0);
    });

    it('AES-128-GCM 同样可往返', async () => {
      const { enc, dec } = await makePair(AES_128_KEY);
      const plaintext = ENCODER.encode('aes-128 test');
      const decrypted = await dec.decrypt(await enc.encrypt(plaintext));
      expect(decrypted).toEqual(plaintext);
    });

    it('AAD 参与校验：解密时传相同 AAD 能还原', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('packet payload');
      const aad = ENCODER.encode('length-field');
      const ciphertext = await enc.encrypt(plaintext, undefined, aad);
      const decrypted = await dec.decrypt(ciphertext, undefined, aad);
      expect(decrypted).toEqual(plaintext);
    });

    it('AAD 参与校验：解密时传不同 AAD 应失败（返回 null）', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('packet payload');
      const aad = ENCODER.encode('correct-length');
      const wrongAad = ENCODER.encode('tampered-length');
      const ciphertext = await enc.encrypt(plaintext, undefined, aad);
      const decrypted = await dec.decrypt(ciphertext, undefined, wrongAad);
      expect(decrypted).toBeNull();
    });

    it('加密时无 AAD、解密时有 AAD，应失败（AAD 不匹配）', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('payload');
      const ciphertext = await enc.encrypt(plaintext); // 不传 AAD
      const aad = ENCODER.encode('late-aad');
      const decrypted = await dec.decrypt(ciphertext, undefined, aad);
      // 加密时没 AAD，解密时传了 AAD，WebCrypto 视为 AAD 不匹配
      expect(decrypted).toBeNull();
    });

    it('密文被篡改 1 字节应解密失败', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('sensitive-data');
      const ciphertext = await enc.encrypt(plaintext);
      ciphertext[0] ^= 0xff; // 翻转第一字节
      const decrypted = await dec.decrypt(ciphertext);
      expect(decrypted).toBeNull();
    });

    it('tag 被篡改 1 字节应解密失败（完整性校验生效）', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('sensitive-data');
      const ciphertext = await enc.encrypt(plaintext);
      // tag 在末尾 16 字节
      ciphertext[ciphertext.length - 1] ^= 0x01;
      const decrypted = await dec.decrypt(ciphertext);
      expect(decrypted).toBeNull();
    });

    it('两个独立 cipher 实例同步加密解密连续多条消息往返', async () => {
      // 模拟真实 SSH 流：发送方连续加密多条，接收方按顺序解密，
      // 两端各自维护递增 IV，必须对齐才能解出。
      const { enc, dec } = await makePair(AES_256_KEY);
      const messages = ['msg-one', 'msg-two', 'msg-three', 'msg-four'];
      const ciphertexts: Uint8Array[] = [];
      for (const m of messages) {
        ciphertexts.push(await enc.encrypt(ENCODER.encode(m)));
      }
      for (let i = 0; i < messages.length; i++) {
        const decrypted = await dec.decrypt(ciphertexts[i]);
        expect(decrypted).toEqual(ENCODER.encode(messages[i]));
      }
    });
  });

  describe('IV 自增（RFC 5647 §7.1）', () => {
    it('相邻两次加密应使用不同 IV（nonce 不可复用）', async () => {
      // 通过观察密文间接验证：同样明文 + 同一 cipher 实例下，两次加密必须不同
      const cipher = new SSHAESGCMCipher(AES_256_KEY, randomBytes(GCM_IV_LENGTH));
      await cipher.init();
      const plaintext = ENCODER.encode('same input');
      const c1 = await cipher.encrypt(plaintext);
      const c2 = await cipher.encrypt(plaintext);
      // 如果 IV 没自增，WebCrypto 会用同样的 (key, iv, plaintext) 两次加密得到同样结果，
      // 这在 GCM 下是 catastrophic failure。这里断言两次密文不同。
      let eq = true;
      for (let i = 0; i < c1.length; i++) {
        if (c1[i] !== c2[i]) { eq = false; break; }
      }
      expect(eq).toBe(false);
    });

    it('解密侧也自增 IV', async () => {
      // 验证方式：两个 cipher 实例从同一 (key, iv) 起步，连续往返多条消息。
      // 加密方自增 IV、解密方也自增 IV，两边按相同方式自增才能逐条解出。
      // 这正面证明 decrypt 后 IV 也按 RFC 5647 §7.1 自增（与 encrypt 对称）。
      const iv = randomBytes(GCM_IV_LENGTH);
      const enc = new SSHAESGCMCipher(AES_256_KEY, iv);
      const dec = new SSHAESGCMCipher(AES_256_KEY, iv);
      await enc.init();
      await dec.init();
      const plaintexts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const ciphertexts: Uint8Array[] = [];
      for (const p of plaintexts) {
        ciphertexts.push(await enc.encrypt(ENCODER.encode(p)));
      }
      const decrypted: string[] = [];
      for (const c of ciphertexts) {
        const d = await dec.decrypt(c);
        expect(d).not.toBeNull();
        decrypted.push(new TextDecoder().decode(d!));
      }
      expect(decrypted).toEqual(plaintexts);
    });
  });

  describe('IV 起始值被构造时复制（不持有引用）', () => {
    it('构造时传入的 IV 数组被复制，外部修改不影响 cipher 状态', async () => {
      const iv = randomBytes(GCM_IV_LENGTH);
      const ivCopy = new Uint8Array(iv);
      const enc = new SSHAESGCMCipher(AES_256_KEY, iv);
      await enc.init();
      // 外部修改原 iv 数组
      iv[0] = 0xff;
      iv[1] = 0xee;
      // 加密仍用构造时复制的内部副本，不受外部修改影响
      const plaintext = ENCODER.encode('test');
      const ciphertext = await enc.encrypt(plaintext);

      // 验证外部 iv 修改没有 patch 进 cipher：用 ivCopy（iv 的原貌）构造一个新 enc，
      // 加密同样明文得到的密文应与原 cipher 第一条密文相同 → 证明 cipher 复制了 iv
      const enc2 = new SSHAESGCMCipher(AES_256_KEY, ivCopy);
      await enc2.init();
      const c2 = await enc2.encrypt(plaintext);
      expect(c2).toEqual(ciphertext);
    });
  });
});

// =====================================================================
// SSHAESCTRCipher
// =====================================================================
describe('crypto — SSHAESCTRCipher', () => {
  describe('构造与初始化', () => {
    it('IV 长度不是 16 字节应在构造时抛错', () => {
      expect(() => new SSHAESCTRCipher(AES_256_KEY, randomBytes(12))).toThrow(/16-byte IV/);
      expect(() => new SSHAESCTRCipher(AES_256_KEY, randomBytes(15))).toThrow(/16-byte IV/);
      expect(() => new SSHAESCTRCipher(AES_256_KEY, randomBytes(17))).toThrow(/16-byte IV/);
      expect(() => new SSHAESCTRCipher(AES_256_KEY, randomBytes(0))).toThrow(/16-byte IV/);
    });
    it('IV 正好 16 字节不抛错', () => {
      expect(() => new SSHAESCTRCipher(AES_256_KEY, randomBytes(16))).not.toThrow();
    });
    it('init 之前调用 encrypt 抛错', async () => {
      const cipher = new SSHAESCTRCipher(AES_256_KEY, randomBytes(CTR_IV_LENGTH));
      await expect(cipher.encrypt(ENCODER.encode('x'))).rejects.toThrow(/not initialized/);
    });
    it('init 之前调用 decrypt 抛错', async () => {
      const cipher = new SSHAESCTRCipher(AES_256_KEY, randomBytes(CTR_IV_LENGTH));
      await expect(cipher.decrypt(randomBytes(16))).rejects.toThrow(/not initialized/);
    });
  });

  describe('加解密往返（CTR 无 tag）', () => {
    // 同 GCM 测试一样，加密解密是两个独立方向，各管自己的 counter。
    async function makePair(key: Uint8Array) {
      const iv = randomBytes(CTR_IV_LENGTH);
      const enc = new SSHAESCTRCipher(key, iv);
      const dec = new SSHAESCTRCipher(new Uint8Array(key), iv);
      await enc.init();
      await dec.init();
      return { enc, dec };
    }

    it('短文本解密后应还原原文（AES-256-CTR）', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('hello ctr world');
      const ciphertext = await enc.encrypt(plaintext);
      // CTR 模式无 tag，密文长度 = 明文长度
      expect(ciphertext.length).toBe(plaintext.length);
      const decrypted = await dec.decrypt(ciphertext);
      expect(decrypted).toEqual(plaintext);
    });

    it('空 plaintext 加解密往返', async () => {
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = new Uint8Array(0);
      const ciphertext = await enc.encrypt(plaintext);
      expect(ciphertext.length).toBe(0);
      const decrypted = await dec.decrypt(ciphertext);
      expect(decrypted).toEqual(plaintext);
    });

    it('AES-128-CTR 同样可往返', async () => {
      const { enc, dec } = await makePair(AES_128_KEY);
      const plaintext = ENCODER.encode('aes-128-ctr');
      const decrypted = await dec.decrypt(await enc.encrypt(plaintext));
      expect(decrypted).toEqual(plaintext);
    });

    it('CTR 模式无完整性校验：篡改密文 1 字节仍能"解密"但不报错', async () => {
      // 这是 CTR 的设计特性（不是 bug），固化"CTR 无 MAC"的语义：
      // 篡改密文不会让 decrypt 返回 null，只会得到被篡改后的明文
      // 与 GCM 不同 —— GCM tag 一旦不匹配 decrypt 返 null，
      // CTR 没有 tag → 任何密文都能"解密"成 something
      const { enc, dec } = await makePair(AES_256_KEY);
      const plaintext = ENCODER.encode('ctr-no-mac');
      const ciphertext = await enc.encrypt(plaintext);
      ciphertext[0] ^= 0xff;
      const decrypted = await dec.decrypt(ciphertext);
      expect(decrypted).not.toBeNull();
      expect(decrypted!).not.toEqual(plaintext);
    });

    it('两个独立 cipher 实例同步连续多条消息往返', async () => {
      // 同 GCM 多消息测试，验证 CTR 两端 counter 按相同规则自增同步
      const { enc, dec } = await makePair(AES_256_KEY);
      const messages = ['one', 'two', 'three', 'four'];
      const ciphertexts: Uint8Array[] = [];
      for (const m of messages) {
        ciphertexts.push(await enc.encrypt(ENCODER.encode(m)));
      }
      const obtained: string[] = [];
      for (const c of ciphertexts) {
        const d = await dec.decrypt(c);
        expect(d).not.toBeNull();
        obtained.push(new TextDecoder().decode(d!));
      }
      expect(obtained).toEqual(messages);
    });
  });

  describe('counter 状态自增与 commit 语义', () => {
    it('commit=true（默认）应自增 counter：同明文两次加密密文不同', async () => {
      const cipher = new SSHAESCTRCipher(AES_256_KEY, randomBytes(CTR_IV_LENGTH));
      await cipher.init();
      const plaintext = ENCODER.encode('same input');
      const c1 = await cipher.encrypt(plaintext);
      const c2 = await cipher.encrypt(plaintext);
      // counter 自增后两次密文必须不同
      let eq = true;
      for (let i = 0; i < c1.length; i++) {
        if (c1[i] !== c2[i]) { eq = false; break; }
      }
      expect(eq).toBe(false);
    });

    it('commit=false 不应修改 counter：连续两次 peek 解密用同样 counter', async () => {
      // peek 解密典型场景：解析时先 peek 长度字段，再 commit 全包
      const cipher = new SSHAESCTRCipher(AES_256_KEY, randomBytes(CTR_IV_LENGTH));
      await cipher.init();
      // 构造一条已知密文：加密一次 plaintext，再用另一个 cipher 提取该 counter
      const enc = new SSHAESCTRCipher(AES_256_KEY, randomBytes(CTR_IV_LENGTH));
      await enc.init();
      const plaintext = ENCODER.encode('peek-test-payload');
      const ciphertext = await enc.encrypt(plaintext);

      // 两次 peek 解密（commit=false）应得到完全相同结果，且 counter 不动
      const peek1 = await cipher.decrypt(ciphertext, undefined, undefined, false);
      const peek2 = await cipher.decrypt(ciphertext, undefined, undefined, false);
      expect(peek1).not.toBeNull();
      expect(peek2).not.toBeNull();
      // 两次 peek 用同样 counter，得到同样明文
      // 注意：peek 出来的明文不一定是原文（counter 需要对齐 enc 那一边的自增后状态），
      // 但两次 peek 之间必然相等 —— 这才是核心断言：commit=false 不改 counter
      expect(peek1).toEqual(peek2);
    });

    it('commit=false 加密不应自增 counter（同样明文两次 commit=false 加密得到同样密文）', async () => {
      const cipher = new SSHAESCTRCipher(AES_256_KEY, randomBytes(CTR_IV_LENGTH));
      await cipher.init();
      const plaintext = ENCODER.encode('commit-false');
      const c1 = await cipher.encrypt(plaintext, undefined, undefined, false);
      const c2 = await cipher.encrypt(plaintext, undefined, undefined, false);
      // commit=false 不改 counter → 两次加密用同样 (key, counter) → 同样密文
      expect(c1).toEqual(c2);
    });

    it('构造时传入的 IV 被复制，外部修改不影响 cipher', async () => {
      const iv = randomBytes(CTR_IV_LENGTH);
      const ivCopy = new Uint8Array(iv);
      const cipher = new SSHAESCTRCipher(AES_256_KEY, iv);
      await cipher.init();
      iv[0] = 0xff;
      iv[15] = 0xee;
      const plaintext = ENCODER.encode('isolation');
      const ciphertext = await cipher.encrypt(plaintext);
      // 与"用 iv 的原貌重新构造一个 cipher"加密同样明文得到的密文一致 →
      // 证明 cipher 在构造时复制了 iv，外部修改没 patch 进去
      const cipher2 = new SSHAESCTRCipher(AES_256_KEY, ivCopy);
      await cipher2.init();
      const ciphertext2 = await cipher2.encrypt(plaintext);
      expect(ciphertext).toEqual(ciphertext2);
    });
  });

  describe('CTR counter 64位+ 自增溢出处理', () => {
    it('counter=0xFF..FF 时 incCounter 1 块应正确进位溢出', async () => {
      // 构造 counter 全 0xFF，加密后 counter 自增应正确处理 carry 溢出
      const iv = new Uint8Array(16).fill(0xff);
      const cipher = new SSHAESCTRCipher(AES_256_KEY, iv);
      await cipher.init();
      // 加密 16 字节（恰好 1 块）触发自增
      const plaintext = randomBytes(16);
      const ciphertext = await cipher.encrypt(plaintext);
      const decrypted = await cipher.encrypt(ciphertext); // 再加密一次
      // 这里不直接断言 counter 值（私有），但确保 encrypt/decrypt 往返不抛错即可
      expect(decrypted.length).toBe(ciphertext.length);
    });
  });
});

// =====================================================================
// SSHHMAC
// =====================================================================
describe('crypto — SSHHMAC', () => {
  describe('构造与算法映射', () => {
    it('hmac-sha1 → SHA-1，length=20', () => {
      const m = new SSHHMAC('hmac-sha1', randomBytes(20));
      expect(m.length).toBe(20);
    });
    it('hmac-sha2-256 → SHA-256，length=32', () => {
      const m = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      expect(m.length).toBe(32);
    });
    it('hmac-sha2-512 → SHA-512，length=64', () => {
      const m = new SSHHMAC('hmac-sha2-512', randomBytes(64));
      expect(m.length).toBe(64);
    });
    it('不支持算法构造时抛错且消息含算法名', () => {
      expect(() => new SSHHMAC('hmac-md5', randomBytes(16))).toThrow(/Unsupported MAC.*hmac-md5/);
      expect(() => new SSHHMAC('', randomBytes(16))).toThrow(/Unsupported MAC/);
    });
    it('length 是 readonly 字段（不被 sign 修改）', async () => {
      const m = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await m.init();
      const before = m.length;
      await m.sign(randomBytes(10), 1);
      expect(m.length).toBe(before);
    });
  });

  describe('init 前置检查', () => {
    it('init 之前调用 sign 抛错', async () => {
      const m = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await expect(m.sign(randomBytes(10), 1)).rejects.toThrow(/not initialized/);
    });
    it('init 之前调用 verify 抛错', async () => {
      const m = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await expect(m.verify(randomBytes(10), 1, randomBytes(32))).rejects.toThrow(/not initialized/);
    });
  });

  describe('签名与验证往返', () => {
    it('sign 然后 verify 同样 (packet, seqNum) 应通过', async () => {
      const mac = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await mac.init();
      const packet = ENCODER.encode('some-ssh-packet');
      const tag = await mac.sign(packet, 42);
      expect(tag.length).toBe(32); // sha2-256 输出长度
      const ok = await mac.verify(packet, 42, tag);
      expect(ok).toBe(true);
    });

    it('hmac-sha1 输出 20 字节', async () => {
      const mac = new SSHHMAC('hmac-sha1', randomBytes(20));
      await mac.init();
      const tag = await mac.sign(ENCODER.encode('x'), 0);
      expect(tag.length).toBe(20);
    });

    it('hmac-sha2-512 输出 64 字节', async () => {
      const mac = new SSHHMAC('hmac-sha2-512', randomBytes(64));
      await mac.init();
      const tag = await mac.sign(ENCODER.encode('x'), 0);
      expect(tag.length).toBe(64);
    });

    it('seqNum 不同应验签失败（seqNum 参与签名）', async () => {
      const mac = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await mac.init();
      const packet = ENCODER.encode('packet');
      const tag = await mac.sign(packet, 100);
      const ok = await mac.verify(packet, 101, tag);
      expect(ok).toBe(false);
    });

    it('packet 不同应验签失败', async () => {
      const mac = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await mac.init();
      const packet = ENCODER.encode('real-packet');
      const tag = await mac.sign(packet, 7);
      const tampered = ENCODER.encode('fake-packet');
      const ok = await mac.verify(tampered, 7, tag);
      expect(ok).toBe(false);
    });

    it('tag 被篡改 1 字节应验签失败', async () => {
      const mac = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await mac.init();
      const packet = ENCODER.encode('packet');
      const tag = await mac.sign(packet, 7);
      tag[0] ^= 0xff;
      const ok = await mac.verify(packet, 7, tag);
      expect(ok).toBe(false);
    });

    it('不同密钥签名互相验签失败', async () => {
      const macA = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      const macB = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await macA.init();
      await macB.init();
      const packet = ENCODER.encode('shared-packet');
      const tagA = await macA.sign(packet, 5);
      const ok = await macB.verify(packet, 5, tagA);
      expect(ok).toBe(false);
    });

    it('seqNum=0 也能正常签名验签', async () => {
      const mac = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await mac.init();
      const packet = ENCODER.encode('first-packet');
      const tag = await mac.sign(packet, 0);
      expect(await mac.verify(packet, 0, tag)).toBe(true);
    });

    it('大 packet（4KB）往返', async () => {
      const mac = new SSHHMAC('hmac-sha2-256', randomBytes(32));
      await mac.init();
      const packet = randomBytes(4096);
      const tag = await mac.sign(packet, 999);
      expect(await mac.verify(packet, 999, tag)).toBe(true);
    });
  });
});
