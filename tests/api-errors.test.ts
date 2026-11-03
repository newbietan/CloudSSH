import { describe, expect, it } from 'vitest';
import { localizedApiError, readApiJson } from '../frontend/src/api-errors';
import { t } from '../frontend/src/i18n';

describe('localizedApiError', () => {
  it('已知服务端消息翻译为当前语言文案而非词条键名', () => {
    const result = localizedApiError(
      { error: 'This share link has already been used' },
      'share.claimFailed'
    );
    // 回归防护：曾出现直接返回键名 "share.errorAlreadyUsed" 泄漏到界面的缺陷
    expect(result).toBe(t('share.errorAlreadyUsed'));
    expect(result).not.toMatch(/^share\./);
  });

  it('未知消息透传原文便于排查', () => {
    expect(
      localizedApiError({ error: 'Some future server message' }, 'share.claimFailed')
    ).toBe('Some future server message');
  });

  it('缺少 error 字段或负载非法时回退兜底词条', () => {
    expect(localizedApiError({}, 'share.claimFailed')).toBe(t('share.claimFailed'));
    expect(localizedApiError(null, 'share.claimFailed')).toBe(t('share.claimFailed'));
    expect(localizedApiError(undefined, 'share.loadFailed')).toBe(t('share.loadFailed'));
  });
});

describe('readApiJson', () => {
  it('把 HTML 文档换成 Access 提示，而不是 JSON 解析异常', async () => {
    const response = new Response('<!DOCTYPE html><html><body>login</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await expect(readApiJson(response, 'api.requestFailed')).rejects.toThrow(t('api.htmlResponse'));
  });

  it('重定向视为被登录页拦截', async () => {
    const response = new Response(null, { status: 302, headers: { location: '/cdn-cgi/access/login' } });
    await expect(readApiJson(response, 'api.requestFailed')).rejects.toThrow(t('api.htmlResponse'));
  });

  it('JSON 错误仍走本地化，成功响应原样返回', async () => {
    const failed = new Response(JSON.stringify({ error: 'This share link has expired' }), {
      status: 400,
    });
    await expect(readApiJson(failed, 'api.requestFailed')).rejects.toThrow(t('share.errorLinkExpired'));

    const ok = new Response(JSON.stringify({ id: 1 }), { status: 200 });
    await expect(readApiJson<{ id: number }>(ok, 'api.requestFailed')).resolves.toEqual({ id: 1 });
  });
});
