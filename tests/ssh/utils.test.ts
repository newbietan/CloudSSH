import { describe, it, expect } from 'vitest';
import {
  concat,
  readUint32,
  writeUint32,
  encodeUint32,
  encodeString,
  toSSHMPInt,
  extractRawECDHPoint,
  encodePrefixedString,
} from '../../src/ssh/utils';

describe('SSH Utils', () => {
  describe('concat', () => {
    it('should concatenate multiple Uint8Arrays', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5]);
      const c = new Uint8Array([6]);

      const result = concat(a, b, c);

      expect(result.length).toBe(6);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('should handle empty arrays', () => {
      const a = new Uint8Array([]);
      const b = new Uint8Array([1, 2]);

      const result = concat(a, b);

      expect(result.length).toBe(2);
      expect(result).toEqual(new Uint8Array([1, 2]));
    });
  });

  describe('readUint32', () => {
    it('should read big-endian uint32', () => {
      const data = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
      const result = readUint32(data, 0);

      expect(result).toBe(256);
    });

    it('should read uint32 at offset', () => {
      const data = new Uint8Array([0xFF, 0x00, 0x00, 0x01, 0x00]);
      const result = readUint32(data, 1);

      expect(result).toBe(256);
    });

    it('should read max uint32', () => {
      const data = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
      const result = readUint32(data, 0);

      expect(result).toBe(0xFFFFFFFF);
    });
  });

  describe('writeUint32', () => {
    it('should write big-endian uint32', () => {
      const data = new Uint8Array(4);
      writeUint32(data, 0, 256);

      expect(data).toEqual(new Uint8Array([0x00, 0x00, 0x01, 0x00]));
    });
  });

  describe('encodeUint32', () => {
    it('should encode uint32 as 4-byte array', () => {
      const result = encodeUint32(256);

      expect(result.length).toBe(4);
      expect(result).toEqual(new Uint8Array([0x00, 0x00, 0x01, 0x00]));
    });
  });

  describe('encodeString', () => {
    it('should encode string with length prefix', () => {
      const result = encodeString('test');

      expect(result.length).toBe(8);

      const length = readUint32(result, 0);
      expect(length).toBe(4);

      const str = new TextDecoder().decode(result.slice(4));
      expect(str).toBe('test');
    });

    it('should encode Uint8Array with length prefix', () => {
      const data = new Uint8Array([1, 2, 3]);
      const result = encodeString(data);

      expect(result.length).toBe(7);

      const length = readUint32(result, 0);
      expect(length).toBe(3);

      expect(result.slice(4)).toEqual(data);
    });

    it('should handle empty string', () => {
      const result = encodeString('');

      expect(result.length).toBe(4);
      expect(readUint32(result, 0)).toBe(0);
    });

    it('should encode multi-byte UTF-8 string (Chinese)', () => {
      const result = encodeString('你好');
      // 你 = 3 bytes, 好 = 3 bytes → 6 bytes + 4 length prefix
      expect(result.length).toBe(10);
      expect(readUint32(result, 0)).toBe(6);
      const decoded = new TextDecoder().decode(result.subarray(4));
      expect(decoded).toBe('你好');
    });

    it('should encode string with embedded null bytes', () => {
      const result = encodeString('a\x00b');
      expect(result.length).toBe(7);
      expect(readUint32(result, 0)).toBe(3);
      expect(result[4]).toBe(0x61);
      expect(result[5]).toBe(0x00);
      expect(result[6]).toBe(0x62);
    });
  });

  // ===================================================================
  // concat — 边界补充
  // ===================================================================
  describe('concat — 边界', () => {
    it('zero arguments returns empty Uint8Array', () => {
      const result = concat();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it('single argument returns a copy', () => {
      const orig = new Uint8Array([1, 2, 3]);
      const result = concat(orig);
      expect(result).toEqual(orig);
      expect(result).not.toBe(orig); // should be a new array
    });

    it('all empty arguments returns empty', () => {
      const result = concat(new Uint8Array(0), new Uint8Array(0));
      expect(result.length).toBe(0);
    });
  });

  // ===================================================================
  // readUint32 / writeUint32 / encodeUint32 — 边界值
  // ===================================================================
  describe('readUint32 / writeUint32 — 边界值', () => {
    it('readUint32 of all zeros is 0', () => {
      expect(readUint32(new Uint8Array([0, 0, 0, 0]), 0)).toBe(0);
    });

    it('readUint32 of 0x80000000 does not overflow to negative', () => {
      // 0x80000000 in JS bit ops would be negative without >>> 0
      const data = new Uint8Array([0x80, 0x00, 0x00, 0x00]);
      expect(readUint32(data, 0)).toBe(0x80000000);
    });

    it('writeUint32(0) writes four zero bytes', () => {
      const buf = new Uint8Array(4);
      writeUint32(buf, 0, 0);
      expect(buf).toEqual(new Uint8Array([0, 0, 0, 0]));
    });

    it('writeUint32(0xFFFFFFFF) writes all-FF', () => {
      const buf = new Uint8Array(4);
      writeUint32(buf, 0, 0xFFFFFFFF);
      expect(buf).toEqual(new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]));
    });

    it('writeUint32(0x80000000) writes correct bytes', () => {
      const buf = new Uint8Array(4);
      writeUint32(buf, 0, 0x80000000);
      expect(buf).toEqual(new Uint8Array([0x80, 0x00, 0x00, 0x00]));
    });

    it('writeUint32 then readUint32 roundtrip for various values', () => {
      const values = [0, 1, 127, 128, 255, 256, 65535, 65536,
                      0x7FFFFFFF, 0x80000000, 0xFFFFFFFF];
      for (const v of values) {
        const buf = new Uint8Array(4);
        writeUint32(buf, 0, v);
        expect(readUint32(buf, 0)).toBe(v);
      }
    });

    it('encodeUint32(0) returns 4 zero bytes', () => {
      expect(encodeUint32(0)).toEqual(new Uint8Array([0, 0, 0, 0]));
    });

    it('encodeUint32(0xFFFFFFFF) returns all-FF', () => {
      expect(encodeUint32(0xFFFFFFFF)).toEqual(new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]));
    });
  });
});

// =====================================================================
// toSSHMPInt — RFC 4251 多精度整数编码
// ---------------------------------------------------------------
// mpint 格式: [4-byte length][integer bytes]
// 规则:
//   - 去掉前导零（但保留至少 1 字节）
//   - 如果最高字节的最高位是 1，需要补一个前导零字节
//     （因为 SSH mpint 用两个补码表示，最高位 1 会被当作负数）
//   - length 字段 = significant.length + (needsLeadingZero ? 1 : 0)
// =====================================================================
describe('SSH Utils — toSSHMPInt', () => {
  describe('正数（最高位 bit=0，不补前导零）', () => {
    it('0x01 → [0,0,0,1, 0x01]', () => {
      const result = toSSHMPInt(new Uint8Array([0x01]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x01]));
    });

    it('0x7F → [0,0,0,1, 0x7F] (最高位 0，不补零)', () => {
      const result = toSSHMPInt(new Uint8Array([0x7F]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x7F]));
    });

    it('0x007F → 去前导零后 [0,0,0,1, 0x7F]', () => {
      const result = toSSHMPInt(new Uint8Array([0x00, 0x7F]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x7F]));
    });

    it('0x7FFF → [0,0,0,2, 0x7F,0xFF]', () => {
      const result = toSSHMPInt(new Uint8Array([0x7F, 0xFF]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 2, 0x7F, 0xFF]));
    });

    it('0x0100 → [0,0,0,2, 0x01,0x00]', () => {
      const result = toSSHMPInt(new Uint8Array([0x01, 0x00]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 2, 0x01, 0x00]));
    });
  });

  describe('正数（最高位 bit=1，需补前导零）', () => {
    it('0x80 → [0,0,0,2, 0x00,0x80] (补前导零避免被当作负数)', () => {
      const result = toSSHMPInt(new Uint8Array([0x80]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 2, 0x00, 0x80]));
    });

    it('0xFF → [0,0,0,2, 0x00,0xFF]', () => {
      const result = toSSHMPInt(new Uint8Array([0xFF]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 2, 0x00, 0xFF]));
    });

    it('0x00FF → 去前导零后 0xFF，最高位 1 → 补零 → [0,0,0,2, 0x00,0xFF]', () => {
      const result = toSSHMPInt(new Uint8Array([0x00, 0xFF]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 2, 0x00, 0xFF]));
    });

    it('0x8000 → [0,0,0,3, 0x00,0x80,0x00]', () => {
      const result = toSSHMPInt(new Uint8Array([0x80, 0x00]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 3, 0x00, 0x80, 0x00]));
    });

    it('0xFFFF → [0,0,0,3, 0x00,0xFF,0xFF]', () => {
      const result = toSSHMPInt(new Uint8Array([0xFF, 0xFF]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 3, 0x00, 0xFF, 0xFF]));
    });
  });

  describe('前导零去除', () => {
    it('0x00000001 → 去掉 3 个前导零 → [0,0,0,1, 0x01]', () => {
      const result = toSSHMPInt(new Uint8Array([0x00, 0x00, 0x00, 0x01]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x01]));
    });

    it('0x0080 → 去前导零后 0x80，最高位 1 → 补零 → [0,0,0,2, 0x00,0x80]', () => {
      const result = toSSHMPInt(new Uint8Array([0x00, 0x80]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 2, 0x00, 0x80]));
    });

    it('保留至少 1 字节：0x000000 → 不全部去掉 → [0,0,0,1, 0x00]', () => {
      // while 条件: start < bytes.length - 1，所以最后一个 0 不会被跳过
      const result = toSSHMPInt(new Uint8Array([0x00, 0x00, 0x00]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x00]));
    });

    it('0x0100FF → 不去中间零（只去前导）→ [0,0,0,3, 0x01,0x00,0xFF]', () => {
      const result = toSSHMPInt(new Uint8Array([0x01, 0x00, 0xFF]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 3, 0x01, 0x00, 0xFF]));
    });

    it('0x00FF80 → 去前导 0x00 → 0xFF80，最高位 1 → 补零 → [0,0,0,3, 0x00,0xFF,0x80]', () => {
      const result = toSSHMPInt(new Uint8Array([0x00, 0xFF, 0x80]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 3, 0x00, 0xFF, 0x80]));
    });
  });

  describe('单调字节 / 单元素数组', () => {
    it('single byte 0x00 → [0,0,0,1, 0x00]', () => {
      const result = toSSHMPInt(new Uint8Array([0x00]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x00]));
    });

    it('single byte 0x01 → [0,0,0,1, 0x01]', () => {
      const result = toSSHMPInt(new Uint8Array([0x01]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x01]));
    });

    it('single byte 0xFF → [0,0,0,2, 0x00,0xFF]', () => {
      const result = toSSHMPInt(new Uint8Array([0xFF]));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 2, 0x00, 0xFF]));
    });
  });

  describe('length 字段验证', () => {
    it('length field always equals significant.length + leadingZero(0 or 1)', () => {
      const cases = [
        new Uint8Array([0x01]),
        new Uint8Array([0x80]),
        new Uint8Array([0x00, 0x01]),
        new Uint8Array([0x00, 0xFF]),
        new Uint8Array([0x7F, 0xFF]),
        new Uint8Array([0xFF, 0xFF]),
        new Uint8Array([0x00, 0x00, 0x7F]),
        new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      ];
      for (const input of cases) {
        const result = toSSHMPInt(input);
        const lengthField = readUint32(result, 0);
        // length = result.length - 4
        expect(lengthField).toBe(result.length - 4);
      }
    });
  });

  describe('大整数（模拟 ECDH 共享密钥）', () => {
    it('32-byte Curve25519 共享密钥：结果 length 字段应为 32 或 33（取决最高位）', () => {
      // 随机 32 字节模拟 shared secret
      const secret = new Uint8Array(32);
      crypto.getRandomValues(secret);
      const result = toSSHMPInt(secret);
      const lengthField = readUint32(result, 0);
      const needsLeadingZero = (secret[0] & 0x80) !== 0;
      expect(lengthField).toBe(32 + (needsLeadingZero ? 1 : 0));
      expect(result.length).toBe(4 + lengthField);
    });

    it('32-byte 全 0：去前导零后保留最后 1 个 0 字节 → [0,0,0,1, 0x00]', () => {
      const result = toSSHMPInt(new Uint8Array(32));
      expect(result).toEqual(new Uint8Array([0, 0, 0, 1, 0x00]));
    });

    it('32-byte 最高位 1：补 1 字节前导零，总长度 4+33=37', () => {
      const secret = new Uint8Array(32);
      secret[0] = 0xFF; // 最高位 1
      const result = toSSHMPInt(secret);
      expect(result.length).toBe(4 + 33);
      expect(result[4]).toBe(0x00); // 补的前导零
      expect(result[5]).toBe(0xFF);
    });

    it('32-byte 最高位 0：不补零，总长度 4+32=36', () => {
      const secret = new Uint8Array(32);
      secret[0] = 0x7F; // 最高位 0
      const result = toSSHMPInt(secret);
      expect(result.length).toBe(4 + 32);
      expect(result[4]).toBe(0x7F); // 无前导零
    });
  });
});

// =====================================================================
// extractRawECDHPoint — 从 SSH EC 公钥 blob 提取原始点
// ---------------------------------------------------------------
// blob 格式: [4-byte keyTypeLen][keyType]
//            [4-byte curveLen][curve]
//            [4-byte pointLen][point]
// 返回 point 部分（不含长度前缀）
// =====================================================================
describe('SSH Utils — extractRawECDHPoint', () => {
  // 构造一个标准 ECDH 公钥 blob 的辅助函数
  function buildEcdhBlob(keyType: string, curve: string, point: Uint8Array): Uint8Array {
    const keyTypeBytes = new TextEncoder().encode(keyType);
    const curveBytes = new TextEncoder().encode(curve);
    const result = new Uint8Array(
      4 + keyTypeBytes.length + 4 + curveBytes.length + 4 + point.length
    );
    let offset = 0;
    writeUint32(result, offset, keyTypeBytes.length);
    offset += 4;
    result.set(keyTypeBytes, offset);
    offset += keyTypeBytes.length;
    writeUint32(result, offset, curveBytes.length);
    offset += 4;
    result.set(curveBytes, offset);
    offset += curveBytes.length;
    writeUint32(result, offset, point.length);
    offset += 4;
    result.set(point, offset);
    return result;
  }

  it('标准 nistp256 公钥点提取', () => {
    // 真实格式: keyType="ecdsa-sha2-nistp256", curve="nistp256", point=65 bytes
    const point = new Uint8Array(65);
    point[0] = 0x04; // uncompressed point prefix
    crypto.getRandomValues(point.subarray(1));
    const blob = buildEcdhBlob('ecdsa-sha2-nistp256', 'nistp256', point);

    const extracted = extractRawECDHPoint(blob);
    expect(extracted).toEqual(point);
  });

  it('Curve25519 公钥点（32 字节）提取', () => {
    const point = new Uint8Array(32);
    crypto.getRandomValues(point);
    const blob = buildEcdhBlob('curve25519-sha256', 'curve25519', point);

    const extracted = extractRawECDHPoint(blob);
    expect(extracted).toEqual(point);
  });

  it('空 point 的 blob', () => {
    const blob = buildEcdhBlob('ecdsa-sha2-nistp256', 'nistp256', new Uint8Array(0));
    const extracted = extractRawECDHPoint(blob);
    expect(extracted.length).toBe(0);
  });

  it('单字节 point', () => {
    const blob = buildEcdhBlob('kex', 'c', new Uint8Array([0x42]));
    const extracted = extractRawECDHPoint(blob);
    expect(extracted).toEqual(new Uint8Array([0x42]));
  });

  it('keyType 和 curve 长度不同时偏移仍正确', () => {
    const point = new Uint8Array([1, 2, 3, 4, 5]);
    // keyType 很长, curve 很短
    const blob = buildEcdhBlob('very-long-keytype-name', 'x', point);
    const extracted = extractRawECDHPoint(blob);
    expect(extracted).toEqual(point);
  });

  it('提取的 subarray 是 blob 的视图（无复制）', () => {
    const point = new Uint8Array([0x04, 0xAA, 0xBB]);
    const blob = buildEcdhBlob('kt', 'cv', point);
    const extracted = extractRawECDHPoint(blob);
    // subarray 返回的是视图，修改原 blob 会反映到 extracted
    blob[blob.length - 1] = 0xFF;
    expect(extracted[extracted.length - 1]).toBe(0xFF);
  });
});

// =====================================================================
// encodePrefixedString
// =====================================================================
describe('SSH Utils — encodePrefixedString', () => {
  it('与 encodeString 结果完全相同', () => {
    const s = 'test-string';
    const a = encodePrefixedString(s);
    const b = encodeString(s);
    expect(a).toEqual(b);
  });

  it('空字符串返回 4 字节零长度前缀', () => {
    const result = encodePrefixedString('');
    expect(result.length).toBe(4);
    expect(readUint32(result, 0)).toBe(0);
  });

  it('Uint8Array 输入也走 encodeString 路径', () => {
    const data = new Uint8Array([0x10, 0x20, 0x30]);
    const result = encodePrefixedString(data);
    expect(result.length).toBe(7);
    expect(readUint32(result, 0)).toBe(3);
    expect(result.subarray(4)).toEqual(data);
  });
});
