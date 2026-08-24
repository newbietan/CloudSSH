/**
 * 设备绑定凭证（L2）——分享会话秒级恢复的"同一浏览器环境"判定。
 *
 * 设计约束与安全模型：
 * - 私钥以 WebCrypto `extractable: false` 生成并持久化于 IndexedDB，任何脚本
 *   都无法导出其字节，只能调用 sign —— 普通用户无法把凭证"复制粘贴"迁移到
 *   另一台设备/浏览器；整目录拷贝浏览器 Profile 属超出本防线范畴的残余风险。
 * - 认领分享时上报公钥（SPKI base64url）绑定到分享记录；断线重连时对
 *   {sessionId, nonce, timestamp} 规范串签名，服务端验签 + nonce 单次消费防重放。
 * - 规范串格式单一来源为 src/types.ts 的 buildResumeChallengeMessage，
 *   前后端共用，避免漂移。
 * - 已知理论边界：原设备持有人主动实时中继签名（签名预言机）不可由客户端
 *   方案阻止，由分享会话全程审计事后追责兜底。
 */

import { buildResumeChallengeMessage } from '../../src/share-resume-schema';

const DB_NAME = 'cloudssh_device_identity';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const KEY_RECORD_ID = 'share-device-signing-v1';

export interface ResumeChallengeParams {
  nonce: string;
  timestamp: number;
  signature: string;
}

export function hasDeviceBindingSupport(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.generateKey === 'function' &&
    typeof indexedDB !== 'undefined'
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

interface StoredKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

async function loadOrCreateKeyPair(): Promise<StoredKeyPair> {
  const db = await openDatabase();
  try {
    const existing = await new Promise<StoredKeyPair | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY_RECORD_ID);
      req.onsuccess = () => resolve(req.result as StoredKeyPair | undefined);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
    });
    if (existing?.publicKey && existing?.privateKey) return existing;

    // extractable=false 仅约束私钥（WebCrypto 规范强制公钥可导出）：
    // 私钥获得 sign 用途且永不可导出，公钥获得 verify 用途用于导出上报。
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(keyPair, KEY_RECORD_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
    return keyPair as StoredKeyPair;
  } finally {
    db.close();
  }
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * 导出设备公钥（SPKI DER base64url）；不支持或失败时返回 null（分享仍可认领，仅无恢复绑定）。
 *
 * 含持久化回读校验：隐私模式等环境下 IndexedDB put 可能静默丢弃——若不做校验，
 * 认领时会用“当次生成”的密钥绑定公钥，而恢复时读不到存储就重新生成新密钥去签名，
 * 与绑定公钥必然失配导致永久 403。回读不一致则视为存储不可靠，返回 null 不绑定，
 * 会话退化为仅凭据恢复（连接性不受影响）。
 */
export async function exportDevicePublicKeySpki(): Promise<string | null> {
  if (!hasDeviceBindingSupport()) return null;
  try {
    const first = await exportStoredPublicKeySpki();
    if (!first) return null;
    // 第二次全新开库回读：两次导出一致才认为密钥可稳定取回
    const second = await exportStoredPublicKeySpki();
    if (!second || second !== first) return null;
    return first;
  } catch {
    return null;
  }
}

async function exportStoredPublicKeySpki(): Promise<string | null> {
  const { publicKey } = await loadOrCreateKeyPair();
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return bufferToBase64Url(spki);
}

/**
 * 生成断线恢复挑战参数；不支持或密钥不可用时返回 null，
 * 服务端仅对绑定了公钥的会话强制校验签名。
 */
export async function createResumeChallengeParams(
  sessionId: string
): Promise<ResumeChallengeParams | null> {
  if (!hasDeviceBindingSupport()) return null;
  try {
    const { privateKey } = await loadOrCreateKeyPair();
    const nonce = randomNonce();
    const timestamp = Date.now();
    const message = buildResumeChallengeMessage(sessionId, nonce, timestamp);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(message)
    );
    return { nonce, timestamp, signature: bufferToBase64Url(signature) };
  } catch {
    return null;
  }
}
