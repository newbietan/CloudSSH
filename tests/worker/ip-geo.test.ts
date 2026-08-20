import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferLocationHint } from '../../src/worker/ip-geo';

describe('IPinfo 区域推断', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('为第三方请求设置超时信号并保留边缘缓存配置', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        country: 'US',
        loc: '37.7749,-122.4194',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(inferLocationHint('example.com')).resolves.toMatchObject({ hint: 'wnam' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & {
        cf?: { cacheTtl?: number; cacheEverything?: boolean };
      },
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cf).toEqual({ cacheTtl: 86400, cacheEverything: true });
  });
});
