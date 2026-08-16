import { describe, expect, it } from 'vitest';
import { parseShareToken } from '../frontend/src/share-session';

describe('一次性 SSH 分享链接', () => {
  it('只接受不携带服务器信息的固定路由和高强度 URL-safe 凭证', () => {
    const token = 'Abc_123-'.repeat(6);
    expect(parseShareToken(`#/share/${token}`)).toBe(token);
    expect(parseShareToken(`#share/${token}`)).toBeNull();
    expect(parseShareToken(`#/share/short`)).toBeNull();
    expect(parseShareToken(`#/share/${token}?host=secret.example.com`)).toBeNull();
    expect(parseShareToken(`#/share/${'a'.repeat(129)}`)).toBeNull();
  });
});
