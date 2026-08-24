import { describe, expect, it } from 'vitest';
import { localizedApiError } from '../frontend/src/api-errors';
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
