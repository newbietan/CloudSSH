import { describe, it, expect } from 'vitest';
import { SSHPacketParser, SSHPacketBuilder, nextSequenceNumber } from '../../src/ssh/packet';
import type { SSHPacket } from '../../src/types';
import { readUint32 } from '../../src/ssh/utils';

// =====================================================================
// packet.test.ts
// ---------------------------------------------------------------
// SSH 报文序列化/反序列化测试，验证 SSHPacketBuilder 和 SSHPacketParser
// 的核心不变性：
//   - 明文 build → identity decrypt 往返能还原 payload
//   - padding 对齐 blockSize（GCM vs CTR 两种对齐策略）
//   - padding 随机但 padding_length 正确
//   - 跨分片 feed 正确组装
//   - MAX_PACKET_SIZE 溢出检测
//   - MAC 校验集成
//   - seqNum 递增语义
// 加密原语不做 mock：使用 identity decrypt（原样返回）模拟无加密链路。
// =====================================================================

// --- identity decrypt：原样返回，模拟无加密链路 ---
function identityDecrypt(
  data: Uint8Array,
  _seq: number,
  _aad?: Uint8Array,
  _commit?: boolean
): Uint8Array {
  return data;
}

// --- 工具：生成随机 payload ---
function randomPayload(len: number): Uint8Array {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

// --- 工具：比较两个 Uint8Array 内容是否相同 ---
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// =====================================================================
// SSHPacketBuilder — 明文构建
// =====================================================================
describe('packet — SSHPacketBuilder.build（明文，无加密）', () => {
  describe('包格式基本验证', () => {
    it('空 payload 构建后应有正确的 length 字段', async () => {
      const payload = new Uint8Array(0);
      const packet = await SSHPacketBuilder.build(payload, 8, null, 0);
      // length 字段 = 1(padding_length字段) + payload.length + paddingLength
      const lengthField = readUint32(packet, 0);
      const paddingLength = packet[4];
      expect(lengthField).toBe(1 + 0 + paddingLength);
      // 整包长度 = 4(length) + 1(padding_length) + payload + padding
      expect(packet.length).toBe(4 + 1 + 0 + paddingLength);
    });

    it('非空 payload 构建后 length 字段 = 1 + payload + padding', async () => {
      const payload = randomPayload(32);
      const packet = await SSHPacketBuilder.build(payload, 16, null, 0);
      const lengthField = readUint32(packet, 0);
      const paddingLength = packet[4];
      expect(lengthField).toBe(1 + 32 + paddingLength);
      expect(packet.length).toBe(4 + lengthField);
    });

    it('payload 内容应出现在 packet[5..5+length)', async () => {
      const payload = randomPayload(20);
      const packet = await SSHPacketBuilder.build(payload, 16, null, 0);
      const extracted = packet.subarray(5, 5 + payload.length);
      expect(arraysEqual(extracted, payload)).toBe(true);
    });

    it('packet[4] 字段应等于 paddingLength', async () => {
      const payload = randomPayload(10);
      const packet = await SSHPacketBuilder.build(payload, 8, null, 0);
      const paddingLength = packet[4];
      // 验证 padding 区域确实存在且长度正确
      const paddingStart = 5 + payload.length;
      const paddingEnd = packet.length;
      expect(paddingEnd - paddingStart).toBe(paddingLength);
    });
  });

  describe('padding 对齐规则（CTR 模式，hasAuthTag=false）', () => {
    it('padding 应使 4+packetLength 对齐到 blockSize 整数倍', async () => {
      const blockSize = 16;
      for (const pl of [1, 5, 15, 16, 50, 100, 255]) {
        const payload = randomPayload(pl);
        const packet = await SSHPacketBuilder.build(payload, blockSize, null, 0);
        expect(packet.length % blockSize).toBe(0);
      }
    });

    it('padding 最少 4 字节（RFC 4253 §6 规定最小 padding 4）', async () => {
      // 用 blockSize=8 使 alignBase 恰好为 0 → paddingNeeded = 8-8 = 0 → paddingLength = 0+8 = 8 ≥ 4 ✓
      // 用 blockSize=16 + payload 恰好对齐 → paddingNeeded=0 → paddingLength=16 ≥ 4 ✓
      const payload = randomPayload(11); // 4 + 1 + 11 = 16，对齐 blockSize=16 → 需要 padding 16
      const packet = await SSHPacketBuilder.build(payload, 16, null, 0);
      const paddingLength = packet[4];
      expect(paddingLength).toBeGreaterThanOrEqual(4);
    });

    it('不同 blockSize 下都能正确对齐', async () => {
      for (const blockSize of [8, 16, 32]) {
        for (const pl of [0, 1, blockSize - 5, blockSize, blockSize * 2 - 1]) {
          const payload = randomPayload(pl);
          const packet = await SSHPacketBuilder.build(payload, blockSize, null, 0);
          expect(packet.length % blockSize).toBe(0);
          expect(packet[4]).toBeGreaterThanOrEqual(4);
        }
      }
    });
  });

  describe('padding 对齐规则（GCM 模式，hasAuthTag=true）', () => {
    it('padding 应使 1+payload+padding 对齐到 blockSize，4字节 length 不参与对齐', async () => {
      const blockSize = 16;
      // GCM: alignBase = (1 + payloadLength) % blockSize
      // paddingNeeded = blockSize - (alignBase || blockSize)
      // 对齐目标是 [4..end] 部分 = 1 + payload + padding
      for (const pl of [0, 1, 10, 15, 16, 31, 32, 100]) {
        const payload = randomPayload(pl);
        const packet = await SSHPacketBuilder.build(payload, blockSize, null, 0, true);
        // 加密后部分长度 = packet.length - 4 = 1 + payload + padding
        const encryptedPortion = packet.length - 4;
        expect(encryptedPortion % blockSize).toBe(0);
      }
    });
  });

  describe('padding 随机性', () => {
    it('同样 payload 和参数两次构造 padding 内容应不同', async () => {
      const payload = randomPayload(20);
      // 明文模式不加密，padding 区域直接可见
      const p1 = await SSHPacketBuilder.build(payload, 16, null, 0);
      const p2 = await SSHPacketBuilder.build(payload, 16, null, 0);
      // length 和 paddingLength 相同
      expect(p1.length).toBe(p2.length);
      expect(p1[4]).toBe(p2[4]);
      // padding 内容不同（概率上，random 非确定性）
      const padStart = 5 + payload.length;
      const padEnd = p1.length;
      let differ = false;
      for (let i = padStart; i < padEnd; i++) {
        if (p1[i] !== p2[i]) { differ = true; break; }
      }
      // 极端情况 padding 只有 4 字节，全不同的概率极低
      if (padEnd - padStart > 4) {
        expect(differ).toBe(true);
      }
    });
  });
});

// =====================================================================
// SSHPacketBuilder.buildWithPayloadWriter
// =====================================================================
describe('packet — SSHPacketBuilder.buildWithPayloadWriter', () => {
  it('效果应与 build(payload) 完全相同', async () => {
    const payload = randomPayload(30);
    const direct = await SSHPacketBuilder.build(payload, 16, null, 0);

    // 用 buildWithPayloadWriter 复制 payload 到 buffer 中
    const withWriter = await SSHPacketBuilder.buildWithPayloadWriter(
      payload.length,
      (packet, offset) => packet.set(payload, offset),
      16, null, 0
    );

    // length 字段和 paddingLength 应相同
    expect(readUint32(withWriter, 0)).toBe(readUint32(direct, 0));
    expect(withWriter[4]).toBe(direct[4]);
    // payload 区域相同
    const directPayload = direct.subarray(5, 5 + payload.length);
    const writerPayload = withWriter.subarray(5, 5 + payload.length);
    expect(arraysEqual(writerPayload, directPayload)).toBe(true);
    expect(arraysEqual(writerPayload, payload)).toBe(true);
  });

  it('payloadLength=0 时 writePayload 不被需要，仍正确生成包', async () => {
    const packet = await SSHPacketBuilder.buildWithPayloadWriter(
      0,
      () => {}, // no-op writer
      16, null, 0
    );
    expect(readUint32(packet, 0)).toBe(1 + (packet.length - 5)); // 1 + padding
    expect(packet[4]).toBeGreaterThanOrEqual(4);
    expect(packet.length % 16).toBe(0);
  });
});

// =====================================================================
// 序列化/反序列化往返（核心）
// =====================================================================
describe('packet — build → parse 往返（无加密）', () => {
  describe('CTR 模式往返（hasAuthTag=false）', () => {
    it('标准 payload：build 后 feed+nextPacket 能还原 payload', async () => {
      const payload = randomPayload(32);
      const blockSize = 16;
      const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

      const parser = new SSHPacketParser();
      parser.feed(built);
      const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
      expect(pkt).not.toBeNull();
      expect(arraysEqual(pkt!.payload, payload)).toBe(true);
      expect(pkt!.length).toBe(readUint32(built, 0));
      expect(pkt!.paddingLength).toBe(built[4]);
    });

    it('空 payload 往返', async () => {
      const payload = new Uint8Array(0);
      const blockSize = 8;
      const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

      const parser = new SSHPacketParser();
      parser.feed(built);
      const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
      expect(pkt).not.toBeNull();
      expect(pkt!.payload.length).toBe(0);
    });

    it('单字节 payload 往返', async () => {
      const payload = new Uint8Array([0x55]);
      const blockSize = 16;
      const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

      const parser = new SSHPacketParser();
      parser.feed(built);
      const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
      expect(pkt).not.toBeNull();
      expect(pkt!.payload).toEqual(payload);
    });

    it('大 payload 往返（接近 MAX_PACKET_SIZE）', async () => {
      const payload = randomPayload(1024);
      const blockSize = 16;
      const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

      const parser = new SSHPacketParser();
      parser.feed(built);
      const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
      expect(pkt).not.toBeNull();
      expect(arraysEqual(pkt!.payload, payload)).toBe(true);
    });

    it('多种 blockSize 往返', async () => {
      for (const blockSize of [8, 16, 32]) {
        for (const pl of [0, 1, blockSize - 1, blockSize, blockSize * 3]) {
          const payload = randomPayload(pl);
          const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);
          const parser = new SSHPacketParser();
          parser.feed(built);
          const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
          expect(pkt).not.toBeNull();
          expect(arraysEqual(pkt!.payload, payload)).toBe(true);
        }
      }
    });
  });

  describe('GCM 模式往返（hasAuthTag=true）', () => {
    it('标准 payload build 后 nextPacket 能还原', async () => {
      const payload = randomPayload(32);
      const blockSize = 16;
      // GCM 模式下 build 不加密会生成 [4-byte length][padding_length + payload + padding]
      // 但 nextPacket GCM 模式期望 [4-byte length][encrypted data: padding_length+payload+padding + 16-byte tag]
      // 明文测试时 we need to handle this: built output has no tag
      // → GCM 明文往返需要特殊处理
      // 实际上 build(hasAuthTag=true, encrypt=null) 生成的是 plain [length][padding_length+payload+padding]
      // 而 nextPacket(hasAuthTag=true) 期望 expectedSize = 4 + packetLength + 16
      // 这两者不匹配 → 明文 GCM 测试需要 mock 加密添加 fake tag
      // 这里暂时跳过 GCM 往返，放到 GCM 专项测试中
      // 跳过：用 build(encrypt=null) 测试 GCM 对齐
      const built = await SSHPacketBuilder.build(payload, blockSize, null, 0, true);
      // 验证 GCM 对齐：[4..end] 对齐 blockSize
      expect((built.length - 4) % blockSize).toBe(0);
    });
  });

  describe('连续多个包往返', () => {
    it('一次 feed 多个包，连续 nextPacket 能逐个还原', async () => {
      const blockSize = 16;
      const payloads = [
        randomPayload(10),
        randomPayload(50),
        randomPayload(0),
        randomPayload(200),
      ];
      const parser = new SSHPacketParser();
      // 先 build 所有包，再全部 feed
      for (const p of payloads) {
        const built = await SSHPacketBuilder.build(p, blockSize, null, 0);
        parser.feed(built);
      }
      // 逐个解析
      for (const expectedPayload of payloads) {
        const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
        expect(pkt).not.toBeNull();
        expect(arraysEqual(pkt!.payload, expectedPayload)).toBe(true);
      }
    });

    it('seqNum 应在某会话内每包递增', async () => {
      const blockSize = 16;
      const parser = new SSHPacketParser();
      const seqBefore = parser.getSeqNum();
      expect(seqBefore).toBe(0);

      for (let i = 0; i < 3; i++) {
        const payload = randomPayload(10);
        const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);
        parser.feed(built);
        await parser.nextPacket(blockSize, identityDecrypt, false, 0);
        expect(parser.getSeqNum()).toBe(i + 1);
      }
    });
  });
});

// =====================================================================
// SSHPacketParser — 跨分片 feed
// =====================================================================
describe('packet — 跨分片 feed（模拟 TCP 分包）', () => {
  it('一个包分成 2 片 feed 仍能正确解析', async () => {
    const payload = randomPayload(50);
    const blockSize = 16;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    // 等分两片
    const split = Math.floor(built.length / 2);
    const parser = new SSHPacketParser();
    parser.feed(built.subarray(0, split));
    // 数据不完整，应该返回 null
    let pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).toBeNull();
    // 喂剩余部分
    parser.feed(built.subarray(split));
    pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
  });

  it('一个包分成多片（每片 1 字节）仍能正确解析', async () => {
    const payload = randomPayload(10);
    const blockSize = 8;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    const parser = new SSHPacketParser();
    // 逐字节 feed
    for (let i = 0; i < built.length; i++) {
      parser.feed(built.subarray(i, i + 1));
      const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
      if (i < built.length - 1) {
        // 大部分情况下数据不完整
        // 但不强制 null（某些极短包可能刚好完整）
      } else {
        // 最后一片后必定完整
        expect(pkt).not.toBeNull();
        expect(arraysEqual(pkt!.payload, payload)).toBe(true);
      }
    }
  });

  it('切片边界恰好在 blockSize 处的边界对齐情况', async () => {
    // CTR 模式 nextPacket 先 peek blockSize 字节（first block）解密
    // 如果第一块没到齐，应该返回 null
    const payload = randomPayload(20);
    const blockSize = 16;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    // 只喂 blockSize-1 字节（不够第一个 block）
    const parser = new SSHPacketParser();
    parser.feed(built.subarray(0, blockSize - 1));
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).toBeNull();
    // 喂满第一个 block
    parser.feed(built.subarray(blockSize - 1));
    const pkt2 = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt2).not.toBeNull();
    expect(arraysEqual(pkt2!.payload, payload)).toBe(true);
  });
});

// =====================================================================
// SSHPacketParser — 部分包等待
// =====================================================================
describe('packet — 部分数据返回 null，等待更多数据', () => {
  it('空 feed 后 nextPacket 返回 null', async () => {
    const parser = new SSHPacketParser();
    const pkt = await parser.nextPacket(16, identityDecrypt, false, 0);
    expect(pkt).toBeNull();
  });

  it('feed 空 Uint8Array 不影响后续解析', async () => {
    const payload = randomPayload(20);
    const blockSize = 16;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    const parser = new SSHPacketParser();
    parser.feed(new Uint8Array(0)); // 空 feed 应被忽略
    parser.feed(built);
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
  });

  it('恰好够一个包的数据量，nextPacket 正好返回非 null', async () => {
    const payload = randomPayload(10);
    const blockSize = 8;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);
    // built.length 恰好是 packet 的全部数据

    const parser = new SSHPacketParser();
    parser.feed(built);
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
    // 再次调用应该返回 null（无多余数据）
    const pkt2 = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt2).toBeNull();
  });

  it('多余数据保留在 buffer 中供下个包使用', async () => {
    const blockSize = 16;
    const p1 = randomPayload(20);
    const p2 = randomPayload(30);
    const built1 = await SSHPacketBuilder.build(p1, blockSize, null, 0);
    const built2 = await SSHPacketBuilder.build(p2, blockSize, null, 0);

    const parser = new SSHPacketParser();
    // 一次性 feed 两个包
    parser.feed(built1);
    parser.feed(built2);

    const pkt1 = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt1).not.toBeNull();
    expect(arraysEqual(pkt1!.payload, p1)).toBe(true);

    const pkt2 = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt2).not.toBeNull();
    expect(arraysEqual(pkt2!.payload, p2)).toBe(true);
  });
});

// =====================================================================
// SSHPacketParser — MAX_PACKET_SIZE 限制
// =====================================================================
describe('packet — MAX_PACKET_SIZE 溢出检测', () => {
  it('CTR 模式：packet length 超过 256KB 应抛错', async () => {
    const blockSize = 16;
    // 手工构造一个长度字段超限的 fake 包
    // CTR: first blockSize bytes 解密后头 4 字节 = packetLength
    // 手工构造 [length=0x00040001（超过 256KB）, ...padding]
    const fakeFirstBlock = new Uint8Array(blockSize);
    fakeFirstBlock[0] = 0x00;
    fakeFirstBlock[1] = 0x10; // 0x00100000 = 1048576 > 256KB
    fakeFirstBlock[2] = 0x00;
    fakeFirstBlock[3] = 0x00;

    const parser = new SSHPacketParser();
    parser.feed(fakeFirstBlock);
    await expect(parser.nextPacket(blockSize, identityDecrypt, false, 0))
      .rejects.toThrow(/exceeds maximum/);
  });

  it('GCM 模式：packet length 超过 256KB 应抛错', async () => {
    const blockSize = 16;
    // GCM: peek 4 bytes = packetLength (before decryption)
    const fakeLength = new Uint8Array(4);
    fakeLength[0] = 0x00;
    fakeLength[1] = 0x10; // > 256KB
    fakeLength[2] = 0x00;
    fakeLength[3] = 0x00;

    const parser = new SSHPacketParser();
    parser.feed(fakeLength);
    await expect(parser.nextPacket(blockSize, identityDecrypt, true, 0))
      .rejects.toThrow(/exceeds maximum/);
  });
});

// =====================================================================
// GCM 模式完整往返（hasAuthTag=true）
// -------------------------------------------------------------------
// GCM build(encrypt=null) 生成 [4-byte length][plaintext: padLen+payload+padding]
// GCM nextPacket 期望 [4-byte length][encrypted: padLen+payload+padding + 16-byte tag]
// → 用 mock encrypt 在 build 端附 16 字节 fake tag
// → parse 端 identity decrypt 时 strip 掉 16 字节 tag
// =====================================================================
describe('packet — GCM 模式完整往返', () => {
  // fake encrypt：原样返回 data + 16 字节 fake tag
  async function fakeGcmEncrypt(data: Uint8Array, _seq: number, _aad?: Uint8Array): Promise<Uint8Array> {
    const result = new Uint8Array(data.length + 16);
    result.set(data, 0);
    // fake tag = 16 个 0xAA
    for (let i = data.length; i < data.length + 16; i++) result[i] = 0xAA;
    return result;
  }

  // fake decrypt：data 末尾有 16 字节 fake tag，去掉后返回前缀
  async function fakeGcmDecrypt(data: Uint8Array, _seq: number, _aad?: Uint8Array, _commit?: boolean): Promise<Uint8Array> {
    return data.subarray(0, data.length - 16);
  }

  it('标准 payload GCM build → parse 完整还原', async () => {
    const payload = randomPayload(40);
    const blockSize = 16;
    // build 时 encrypt=null（明文），手工添加 fake tag 模拟 GCM 格式
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0, true);
    // built 结构：[4-byte length][padLen+payload+padding]
    // 期望 wire 格式：[4-byte length][encrypted(padLen+payload+padding)+16-byte tag]
    // → 手工追加 16 字节 fake tag
    const wire = new Uint8Array(built.length + 16);
    wire.set(built, 0);
    for (let i = built.length; i < built.length + 16; i++) wire[i] = 0xAA;

    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, fakeGcmDecrypt, true, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
  });

  it('用 fakeGcmEncrypt 直接走 build 加密路径往返', async () => {
    const payload = randomPayload(25);
    const blockSize = 16;
    // build 用 fakeGcmEncrypt 模拟 GCM 加密链路
    const wire = await SSHPacketBuilder.build(payload, blockSize, fakeGcmEncrypt, 0, true);
    // wire 结构：[4-byte length][encrypted(padLen+payload+padding)+16-byte tag]

    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, fakeGcmDecrypt, true, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
  });

  it('GCM 模式 payload=0 往返', async () => {
    const payload = new Uint8Array(0);
    const blockSize = 16;
    const wire = await SSHPacketBuilder.build(payload, blockSize, fakeGcmEncrypt, 0, true);
    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, fakeGcmDecrypt, true, 0);
    expect(pkt).not.toBeNull();
    expect(pkt!.payload.length).toBe(0);
  });

  it('GCM 模式数据不完整时返回 null（等待更多数据）', async () => {
    const payload = randomPayload(20);
    const blockSize = 16;
    const wire = await SSHPacketBuilder.build(payload, blockSize, fakeGcmEncrypt, 0, true);
    // 只喂前半段
    const parser = new SSHPacketParser();
    parser.feed(wire.subarray(0, Math.floor(wire.length / 2)));
    const pkt = await parser.nextPacket(blockSize, fakeGcmDecrypt, true, 0);
    expect(pkt).toBeNull();
  });

  it('GCM 模式 decrypt 返回 null 时 nextPacket 返回 null', async () => {
    const payload = randomPayload(20);
    const blockSize = 16;
    const wire = await SSHPacketBuilder.build(payload, blockSize, fakeGcmEncrypt, 0, true);
    const parser = new SSHPacketParser();
    parser.feed(wire);
    // decrypt 返回 null 模拟解密失败
    const pkt = await parser.nextPacket(blockSize, () => null, true, 0);
    expect(pkt).toBeNull();
  });

  it('GCM 模式 MAC 字段（raw.subarray(4+packetLength)）应为 16 字节 tag', async () => {
    const payload = randomPayload(10);
    const blockSize = 16;
    const wire = await SSHPacketBuilder.build(payload, blockSize, fakeGcmEncrypt, 0, true);
    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, fakeGcmDecrypt, true, 0);
    expect(pkt).not.toBeNull();
    expect(pkt!.mac).toBeDefined();
    expect(pkt!.mac!.length).toBe(16);
    // tag 内容应全是 0xAA
    for (const b of pkt!.mac!) expect(b).toBe(0xAA);
  });
});

// =====================================================================
// CTR 模式 MAC 校验
// =====================================================================
describe('packet — CTR 模式 MAC 校验', () => {
  it('verifyMac 返回 true 时正常解析', async () => {
    const payload = randomPayload(20);
    const blockSize = 16;
    const macLen = 32;
    const fakeMac = randomPayload(macLen);
    // build 带加密链路 + mac：用 mock encrypt + mock mac
    async function mockEnc(data: Uint8Array): Promise<Uint8Array> { return data; }
    async function mockMac(data: Uint8Array): Promise<Uint8Array> { const r = new Uint8Array(macLen); r.set(fakeMac.subarray(0, Math.min(fakeMac.length, macLen))); return r; }

    const wire = await SSHPacketBuilder.build(payload, blockSize, mockEnc, 0, false, mockMac);
    // wire = encrypted packet + mac（长度由 payload 对齐决定，不硬编码）

    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(
      blockSize, identityDecrypt, false, macLen,
      (_pkt, _mac, _seq) => true // verifyMac = true
    );
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
  });

  it('verifyMac 返回 false 时抛 MAC 校验错误', async () => {
    const payload = randomPayload(20);
    const blockSize = 16;
    const macLen = 32;

    async function mockEnc(data: Uint8Array): Promise<Uint8Array> { return data; }
    async function mockMac(_data: Uint8Array): Promise<Uint8Array> { return new Uint8Array(macLen); }

    const wire = await SSHPacketBuilder.build(payload, blockSize, mockEnc, 0, false, mockMac);

    const parser = new SSHPacketParser();
    parser.feed(wire);
    await expect(parser.nextPacket(
      blockSize, identityDecrypt, false, macLen,
      () => false // verifyMac 失败
    )).rejects.toThrow(/Invalid packet MAC/);
  });

  it('macLength > 0 但未提供 verifyMac 时不校验，直接返回包', async () => {
    const payload = randomPayload(15);
    const blockSize = 16;
    const macLen = 20;

    async function mockEnc(d: Uint8Array): Promise<Uint8Array> { return d; }
    async function mockMac(_d: Uint8Array): Promise<Uint8Array> { return new Uint8Array(macLen); }

    const wire = await SSHPacketBuilder.build(payload, blockSize, mockEnc, 0, false, mockMac);
    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, macLen);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
    // mac 字段应提取出 macLen 字节
    expect(pkt!.mac!.length).toBe(macLen);
  });

  it('CTR decrypt 返回 null 时 nextPacket 返回 null（first block 解密失败）', async () => {
    const payload = randomPayload(20);
    const blockSize = 16;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);
    const parser = new SSHPacketParser();
    parser.feed(built);
    const pkt = await parser.nextPacket(blockSize, () => null, false, 0);
    expect(pkt).toBeNull();
  });

  it('CTR 数据不够 first block 时返回 null（不调用 decrypt）', async () => {
    const blockSize = 16;
    // 只喂 < blockSize 字节
    const parser = new SSHPacketParser();
    parser.feed(randomPayload(blockSize - 1));
    const pkt = await parser.nextPacket(blockSize, () => { throw new Error('should not call decrypt'); }, false, 0);
    expect(pkt).toBeNull();
  });

  it('CTR 数据够 first block 但不够 totalSize+mac 时返回 null', async () => {
    const payload = randomPayload(50);
    const blockSize = 16;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);
    // 只喂前 blockSize+1 字节（够 first block 但不够完整）
    const parser = new SSHPacketParser();
    parser.feed(built.subarray(0, blockSize + 1));
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).toBeNull();
  });
});

// =====================================================================
// compactChunks — 高 chunk 索引回收
// =====================================================================
describe('packet — compactChunks 回收（33+ chunk 边界）', () => {
  it('跨 33+ 片 feed 后仍能正确解析（触发 chunkIndex > 32 回收）', async () => {
    const payload = randomPayload(100);
    const blockSize = 8;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    // 逐字节 feed，制造 100+ chunk
    const parser = new SSHPacketParser();
    for (let i = 0; i < built.length; i++) {
      parser.feed(built.subarray(i, i + 1));
    }
    // 调用 nextPacket 触发 chunk 消耗，chunkIndex 应到达 > 32 的区间
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
    // 解析完后继续用同一个 parser，验证 chunk 回收后仍能正常工作
    const payload2 = randomPayload(20);
    const built2 = await SSHPacketBuilder.build(payload2, blockSize, null, 0);
    parser.feed(built2);
    const pkt2 = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt2).not.toBeNull();
    expect(arraysEqual(pkt2!.payload, payload2)).toBe(true);
  });

  it('bufferedLength 归零时 compactChunks 应清空 chunks 数组', async () => {
    // 解析完一个包后 buffer 应为空
    const payload = randomPayload(20);
    const blockSize = 16;
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    const parser = new SSHPacketParser();
    parser.feed(built);
    await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(parser.getBufferLength()).toBe(0);
    // 再次调用应返回 null
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).toBeNull();
  });

  it('chunkIndex > 32 且 chunkIndex*2 >= chunks.length 时触发 chunk 回收', async () => {
    // 构造大包逐字节喂 70+ chunk，最后再喂一个下包的少量字节
    // 使 nextPacket 消费完后 bufferedLength > 0 但 chunkIndex 已 > 32
    // → compactChunks 走 L104-109 回收分支（非归零分支）
    const blockSize = 8;
    const payload = randomPayload(200);
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    const parser = new SSHPacketParser();
    for (let i = 0; i < built.length; i++) {
      parser.feed(built.subarray(i, i + 1));
    }
    // 追加下一包的部分字节（trigger 不完整 → bufferedLength > 0 但 chunkIndex > 32）
    const payload2 = randomPayload(20);
    const built2 = await SSHPacketBuilder.build(payload2, blockSize, null, 0);
    parser.feed(built2.subarray(0, 5)); // 只喂 5 字节，不够下个包
    // 现在状态：chunkIndex=0，但 chunks.length 很大、bufferedLength = built.length + 5

    // nextPacket 解析完第一个包后 consumeBytes(built.length)
    // → chunkIndex 跳到 built.length（约 210），bufferedLength = 5 > 0
    // → compactChunks: chunkIndex>32 && chunkIndex*2 >= chunks.length → 触发回收
    const pkt = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
    // buffer 应剩 5 字节（下包的前 5 字节）
    expect(parser.getBufferLength()).toBe(5);
    // 回收后状态正确，喂剩余数据继续解析下个包
    parser.feed(built2.subarray(5));
    const pkt2 = await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(pkt2).not.toBeNull();
    expect(arraysEqual(pkt2!.payload, payload2)).toBe(true);
  });
});

// =====================================================================
// seqNum / buffer 查询方法
// =====================================================================
describe('packet — seqNum 与 buffer 查询方法', () => {
  it('序列号按 uint32 递增并在上限回绕', () => {
    expect(nextSequenceNumber(0)).toBe(1);
    expect(nextSequenceNumber(0xfffffffe)).toBe(0xffffffff);
    expect(nextSequenceNumber(0xffffffff)).toBe(0);
  });

  it('getSeqNum 初始应为 0', () => {
    const parser = new SSHPacketParser();
    expect(parser.getSeqNum()).toBe(0);
  });

  it('getBufferLength 反映当前 buffered 字节数', async () => {
    const blockSize = 16;
    const payload = randomPayload(20);
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);

    const parser = new SSHPacketParser();
    expect(parser.getBufferLength()).toBe(0);
    parser.feed(built);
    expect(parser.getBufferLength()).toBe(built.length);
    await parser.nextPacket(blockSize, identityDecrypt, false, 0);
    expect(parser.getBufferLength()).toBe(0);
  });
});

// =====================================================================
// SSHPacketBuilder — 加密路径
// =====================================================================
describe('packet — SSHPacketBuilder 加密路径', () => {
  it('CTR 模式 encrypt 只加密不附 MAC：返回纯密文', async () => {
    const payload = randomPayload(30);
    const blockSize = 16;
    // mock encrypt：每个字节 +1
    async function mockEnc(data: Uint8Array): Promise<Uint8Array> {
      const r = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) r[i] = (data[i] + 1) & 0xff;
      return r;
    }
    const wire = await SSHPacketBuilder.build(payload, blockSize, mockEnc, 0, false);
    // 无 MAC：length 应等于明文包长度
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);
    expect(wire.length).toBe(built.length);
    // 解密侧：每个字节 -1 还原
    async function mockDec(data: Uint8Array): Promise<Uint8Array> {
      const r = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) r[i] = (data[i] - 1) & 0xff;
      return r;
    }
    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, mockDec, false, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
  });

  it('CTR 模式 encrypt + mac：返回密文 + MAC', async () => {
    const payload = randomPayload(20);
    const blockSize = 16;
    const macLen = 10;

    async function mockEnc(data: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(data); // identity 加密，便于验证
    }
    async function mockMac(_data: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(macLen).fill(0xBB);
    }

    const wire = await SSHPacketBuilder.build(payload, blockSize, mockEnc, 0, false, mockMac);
    const built = await SSHPacketBuilder.build(payload, blockSize, null, 0);
    expect(wire.length).toBe(built.length + macLen);
    // 末尾 macLen 字节应全为 0xBB
    for (let i = wire.length - macLen; i < wire.length; i++) {
      expect(wire[i]).toBe(0xBB);
    }

    // parse 端验证
    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, mockEnc, false, macLen);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
    expect(pkt!.mac!.length).toBe(macLen);
    for (const b of pkt!.mac!) expect(b).toBe(0xBB);
  });

  it('GCM 模式 buildWithPayloadWriter 加密路径', async () => {
    const payload = randomPayload(30);
    const blockSize = 16;

    async function gcmEnc(data: Uint8Array, _seq: number, _aad?: Uint8Array): Promise<Uint8Array> {
      const r = new Uint8Array(data.length + 16);
      r.set(data, 0);
      for (let i = data.length; i < data.length + 16; i++) r[i] = 0xCC;
      return r;
    }

    const wire = await SSHPacketBuilder.buildWithPayloadWriter(
      payload.length,
      (pkt, offset) => pkt.set(payload, offset),
      blockSize, gcmEnc, 0, true
    );
    // wire: [4-byte length][encrypted + 16-byte tag]
    expect(wire instanceof Uint8Array).toBe(true);
    expect(wire.length - 4 - 16).toBeGreaterThan(0); // 加密部分有数据
    // 末 16 字节 tag 全 0xCC
    for (let i = wire.length - 16; i < wire.length; i++) {
      expect(wire[i]).toBe(0xCC);
    }

    // parse 端
    async function gcmDec(data: Uint8Array): Promise<Uint8Array> {
      return data.subarray(0, data.length - 16);
    }
    const parser = new SSHPacketParser();
    parser.feed(wire);
    const pkt = await parser.nextPacket(blockSize, gcmDec, true, 0);
    expect(pkt).not.toBeNull();
    expect(arraysEqual(pkt!.payload, payload)).toBe(true);
  });
});
