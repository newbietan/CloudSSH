import { describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../frontend/src/clipboard';

describe('剪贴板写入', () => {
  it('优先使用 Clipboard API，并且成功后不调用回退方案', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    const legacyCopy = vi.fn(() => true);

    await expect(copyTextToClipboard('hello', clipboard, legacyCopy)).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(legacyCopy).not.toHaveBeenCalled();
  });

  it('Clipboard API 被拒绝时回退，并透传浏览器报告的复制结果', async () => {
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('denied')) };
    const legacyCopy = vi.fn(() => true);

    await expect(copyTextToClipboard('hello', clipboard, legacyCopy)).resolves.toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith('hello');

    legacyCopy.mockReturnValue(false);
    await expect(copyTextToClipboard('hello', clipboard, legacyCopy)).resolves.toBe(false);
  });

  it('空文本或回退方案异常时返回失败', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    const legacyCopy = vi.fn(() => {
      throw new Error('unsupported');
    });

    await expect(copyTextToClipboard('', clipboard, legacyCopy)).resolves.toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(legacyCopy).not.toHaveBeenCalled();
    await expect(copyTextToClipboard('hello', null, legacyCopy)).resolves.toBe(false);
  });
});
