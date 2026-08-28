/**
 * PKCS#1 / PKCS#8 / SEC1 私钥解析（未加密封装）。
 *
 * 输出与格式无关的组件结构（PkcsPrivateKey），由 auth.ts 统一构建
 * WebCrypto CryptoKey 与 SSH 公钥 blob。本模块不含 WebCrypto 依赖，可单独测试。
 *
 * 覆盖的 PEM 封装（由上层 auth.ts 识别分发）：
 *  - `BEGIN RSA PRIVATE KEY`（PKCS#1，RFC 8017）—— AWS EC2 .pem / openssl genrsa 常见输出
 *  - `BEGIN EC PRIVATE KEY`（SEC1，RFC 5915）
 *  - `BEGIN PRIVATE KEY`（PKCS#8，RFC 5958）—— 内层按算法 OID 分发
 *  - `BEGIN ENCRYPTED PRIVATE KEY` / Proc-Type 加密 PEM 由上层明确拒绝
 */

import {
  type DerNode,
  DerError,
  bitStringBytes,
  decodeOid,
  expectIntegerValue,
  expectTag,
  integerBytes,
  parseDer,
  sequenceChildren,
  stripLeadingZeros,
  TAG_CONTEXT_0,
  TAG_CONTEXT_1,
  TAG_OID,
  TAG_OCTET_STRING,
  TAG_SEQUENCE,
} from './der';

/** RFC 8017 附录 C：rsaEncryption。 */
export const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
/** RFC 5480：ecPublicKey。 */
export const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
/** RFC 8410：Ed25519。 */
export const OID_ED25519 = '1.3.101.112';

export type EcNamedCurve = 'P-256' | 'P-384' | 'P-521';

/** RFC 5480 §2.1 命名曲线 OID → WebCrypto namedCurve。 */
const CURVE_OIDS: Record<string, EcNamedCurve> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/** RFC 5480：素数域 fieldType OID（SpecifiedECDomain 的 fieldID.fieldType）。 */
const OID_PRIME_FIELD = '1.2.840.10045.1.1';

/** 素数字节长度（去符号填充后）→ 命名曲线（SpecifiedECDomain 显式参数形态）。 */
const CURVE_BY_PRIME_LENGTH: Record<number, EcNamedCurve> = {
  32: 'P-256',
  48: 'P-384',
  66: 'P-521',
};

export interface RsaComponents {
  kind: 'rsa';
  n: Uint8Array;
  e: Uint8Array;
  d: Uint8Array;
  p: Uint8Array;
  q: Uint8Array;
  iqmp: Uint8Array;
}

export interface EcComponents {
  kind: 'ec';
  namedCurve: EcNamedCurve;
  /** 私钥标量原始字节（去掉可能的符号填充）。 */
  privateKey: Uint8Array;
  /** SEC1 [1] 的非压缩公钥点（0x04 || X || Y）；缺失时由上层经 JWK 导出推导。 */
  publicKey: Uint8Array | null;
}

export interface Ed25519Components {
  kind: 'ed25519';
  seed: Uint8Array;
}

export type PkcsPrivateKey = RsaComponents | EcComponents | Ed25519Components;

/**
 * 解析 PKCS#1 RSAPrivateKey（RFC 8017 §A.1.2）：
 * SEQUENCE { version, n, e, d, p, q, dP, dQ, qInv, otherPrimeInfos? }
 */
export function parsePkcs1Rsa(der: Uint8Array): RsaComponents {
  const context = 'PKCS#1';
  const fields = sequenceChildren(parseDer(der, context), context);
  if (fields.length < 9) {
    throw new DerError(`${context}: RSA 私钥字段不足（${fields.length}/9）`);
  }
  if (fields.length > 9) {
    throw new DerError(`${context}: 不支持多素数 RSA 密钥`);
  }
  expectIntegerValue(fields[0], 0, context);
  return {
    kind: 'rsa',
    n: integerBytes(fields[1], context),
    e: integerBytes(fields[2], context),
    d: integerBytes(fields[3], context),
    p: integerBytes(fields[4], context),
    q: integerBytes(fields[5], context),
    // coefficient (qInv) 在 PKCS#1 中位于第 9 个字段；SSH wire 顺序为 n,e,d,iqmp,p,q
    iqmp: integerBytes(fields[8], context),
  };
}

/**
 * 解析 SEC1 ECPrivateKey（RFC 5915 §3）：
 * SEQUENCE { version(1), privateKey OCTET STRING, [0] parameters?, [1] publicKey? }
 *
 * @param forcedCurve 上层（PKCS#8）已确定曲线时直接传入，容忍文件缺 [0] 参数
 */
export function parseSec1Ec(der: Uint8Array, forcedCurve?: EcNamedCurve): EcComponents {
  const context = 'SEC1';
  const fields = sequenceChildren(parseDer(der, context), context);
  if (fields.length < 2) {
    throw new DerError(`${context}: EC 私钥字段不足`);
  }
  expectIntegerValue(fields[0], 1, context);
  const privateKey = stripLeadingZeros(
    expectTag(fields[1], TAG_OCTET_STRING, 'OCTET STRING', context)
  );

  let curveOid: string | null = null;
  let curveFromSpecified: EcNamedCurve | null = null;
  let publicKey: Uint8Array | null = null;
  for (let i = 2; i < fields.length; i++) {
    const node = fields[i];
    if (node.tag === TAG_CONTEXT_0 && node.children && node.children.length === 1) {
      const param = node.children[0];
      if (param.tag === TAG_OID) {
        curveOid = decodeOid(param, context);
      } else if (param.tag === TAG_SEQUENCE) {
        // SpecifiedECDomain（显式曲线参数）：macOS `ssh-keygen -m PEM` 转换 EC 密钥
        // 时不写命名曲线 OID，而是写完整素数域参数（真实用户会粘贴的形态）
        curveFromSpecified = parseSpecifiedEcDomain(param, context);
      }
    } else if (node.tag === TAG_CONTEXT_1 && node.children && node.children.length === 1) {
      publicKey = bitStringBytes(node.children[0], context);
    }
  }

  if (publicKey !== null) {
    // 非压缩点固定为 0x04 || X || Y
    if (publicKey.length < 1 || publicKey[0] !== 0x04) {
      throw new DerError(`${context}: 仅支持非压缩公钥点（0x04 前缀）`);
    }
  }

  let namedCurve: EcNamedCurve;
  if (forcedCurve) {
    namedCurve = forcedCurve;
  } else if (curveOid) {
    const mapped = CURVE_OIDS[curveOid];
    if (!mapped) {
      throw new DerError(`${context}: 不支持的椭圆曲线 OID ${curveOid}`);
    }
    namedCurve = mapped;
  } else if (curveFromSpecified) {
    namedCurve = curveFromSpecified;
  } else {
    throw new DerError(`${context}: 缺少曲线参数`);
  }

  return { kind: 'ec', namedCurve, privateKey, publicKey };
}

/**
 * 从 SpecifiedECDomain（RFC 5480 §3.3 显式参数形态）识别命名曲线：
 * SEQUENCE { version(1), fieldID SEQUENCE { OID prime-field, INTEGER prime }, curve, base, order, ... }
 * 仅支持素数域曲线，以素数字节长度映射到 P-256/P-384/P-521。
 */
function parseSpecifiedEcDomain(node: DerNode, context: string): EcNamedCurve {
  const fields = node.children ?? [];
  if (fields.length < 2) {
    throw new DerError(`${context}: SpecifiedECDomain 字段不足`);
  }
  expectIntegerValue(fields[0], 1, context);
  const fieldId = sequenceChildren(fields[1], context);
  if (fieldId.length < 2) {
    throw new DerError(`${context}: FieldID 字段不足`);
  }
  const fieldType = decodeOid(fieldId[0], context);
  if (fieldType !== OID_PRIME_FIELD) {
    throw new DerError(`${context}: 仅支持素数域曲线（fieldType ${fieldType}）`);
  }
  const prime = integerBytes(fieldId[1], context);
  const curve = CURVE_BY_PRIME_LENGTH[prime.length];
  if (!curve) {
    throw new DerError(`${context}: 无法从素数域规模识别曲线（${prime.length} 字节）`);
  }
  return curve;
}

/**
 * 解析 PKCS#8 PrivateKeyInfo（RFC 5958）：
 * SEQUENCE { version, privateKeyAlgorithm AlgorithmIdentifier, privateKey OCTET STRING, attributes? }
 * 按算法 OID 分发到 PKCS#1（RSA）/ SEC1（EC）/ Ed25519（RFC 8410 裸种子）。
 */
export function parsePkcs8(der: Uint8Array): PkcsPrivateKey {
  const context = 'PKCS#8';
  const fields = sequenceChildren(parseDer(der, context), context);
  if (fields.length < 3) {
    throw new DerError(`${context}: PrivateKeyInfo 字段不足`);
  }
  expectIntegerValue(fields[0], 0, context);

  const algo = sequenceChildren(fields[1], context);
  if (algo.length < 1) {
    throw new DerError(`${context}: AlgorithmIdentifier 缺少算法 OID`);
  }
  const algorithmOid = decodeOid(algo[0], context);
  const inner = expectTag(fields[2], TAG_OCTET_STRING, 'OCTET STRING', context);

  switch (algorithmOid) {
    case OID_RSA_ENCRYPTION:
      return parsePkcs1Rsa(inner);

    case OID_EC_PUBLIC_KEY: {
      // 曲线参数两种形态均可能出现（macOS ssh-keygen 写 SpecifiedECDomain）：
      //   [1] OID → 命名曲线；[1] SEQUENCE → SpecifiedECDomain；缺省 → 依赖内层 SEC1 自带参数
      let namedCurve: EcNamedCurve | null = null;
      if (algo.length >= 2) {
        if (algo[1].tag === TAG_OID) {
          const curveOid = decodeOid(algo[1], context);
          namedCurve = CURVE_OIDS[curveOid] ?? null;
          if (!namedCurve) {
            throw new DerError(`${context}: 不支持的椭圆曲线 OID ${curveOid}`);
          }
        } else if (algo[1].tag === TAG_SEQUENCE) {
          namedCurve = parseSpecifiedEcDomain(algo[1], context);
        }
      }
      // 内层为 SEC1 ECPrivateKey；曲线以 PKCS#8 参数为准，容忍文件内缺省或形态不一
      return parseSec1Ec(inner, namedCurve ?? undefined);
    }

    case OID_ED25519: {
      // RFC 8410 §7：privateKey = OCTET STRING 套圈后再包一层 OCTET STRING(32B 种子)，
      // 即 04 22 04 20 <seed>；部分实现也可能直接写 32 字节裸种子，两者都接受
      if (inner.length === 34 && inner[0] === 0x04 && inner[1] === 0x20) {
        return { kind: 'ed25519', seed: inner.subarray(2) };
      }
      if (inner.length === 32) {
        return { kind: 'ed25519', seed: inner };
      }
      throw new DerError(
        `${context}: Ed25519 种子长度异常（期望 32 或 34 字节，实际 ${inner.length}）`,
      );
    }

    default:
      throw new DerError(`${context}: 不支持的算法 OID ${algorithmOid}`);
  }
}
