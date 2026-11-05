import { expect, test } from './fixtures';
import { mockAnonymousSession } from './helpers';

test('下载失败后释放已收到的分片，避免队列空闲时保留大文件内存', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  const state = await page.evaluate(async () => {
    const module = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new module.SFTPPanel(() => null);
    panel.visible = true;
    panel.sftpReady = true;
    panel.sendJSON = () => {};
    const download = panel.downloadFile('/home/user/file', 'file');
    panel.handleBinaryData(new Uint8Array([1, 2, 3]));
    const bufferedBeforeError = panel.downloadChunks.length;
    panel.handleMessage({ type: 'sftp_error', operation: 'download', message: 'download limit' });
    await download;
    const result = {
      bufferedBeforeError,
      bufferedAfterError: panel.downloadChunks.length,
      filenameAfterError: panel.downloadFilename,
    };
    panel.dispose();
    return result;
  });
  expect(state.bufferedBeforeError).toBe(1);
  expect(state.bufferedAfterError).toBe(0);
  expect(state.filenameAfterError).toBe('');
});
