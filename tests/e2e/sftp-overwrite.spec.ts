import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test('SFTP only overwrites an existing file after explicit confirmation', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  await page.evaluate(async () => {
    const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new sftpModule.SFTPPanel(() => null);
    const frames: Array<Record<string, unknown>> = [];
    const binaryChunks: number[] = [];

    (panel as any).visible = true;
    (panel as any).sftpReady = true;
    (panel as any).sendJSON = (frame: Record<string, unknown>) => {
      frames.push(frame);
      if (frame.type === 'sftp_upload_start' && frame.overwrite === false) {
        queueMicrotask(() => panel.handleMessage({
          type: 'sftp_upload_conflict',
          path: frame.path,
          existingSize: 2048,
        }));
      } else if (frame.type === 'sftp_upload_start' && frame.overwrite === true) {
        queueMicrotask(() => panel.handleMessage({ type: 'sftp_upload_ready', path: frame.path }));
      } else if (frame.type === 'sftp_upload_end') {
        queueMicrotask(() => panel.handleMessage({
          type: 'sftp_upload_complete',
          path: '/home/deploy/config.yml',
        }));
      }
    };
    (panel as any).sendBinary = (data: Uint8Array) => {
      binaryChunks.push(data.length);
      queueMicrotask(() => panel.handleMessage({
        type: 'sftp_upload_progress',
        loaded: data.length,
        total: data.length,
      }));
    };

    const uploadPromise = (panel as any).uploadSingleFile(
      new File(['new'], 'config.yml', { type: 'text/yaml' }),
      '/home/deploy',
    );
    (window as any).__sftpOverwriteTest = { panel, frames, binaryChunks, uploadPromise };
  });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('覆盖同名文件');
  await expect(dialog).toContainText('config.yml');
  await expect(dialog).toContainText('2.0 KB');
  await expect(dialog).toContainText('3 B');
  await expect(dialog.locator('.app-dialog__button--cancel')).toBeFocused();

  const beforeConfirmation = await page.evaluate(() => {
    const testState = (window as any).__sftpOverwriteTest;
    return {
      uploadStarts: testState.frames.filter(
        (frame: Record<string, unknown>) => frame.type === 'sftp_upload_start',
      ),
      binaryChunks: [...testState.binaryChunks],
    };
  });
  expect(beforeConfirmation.uploadStarts).toEqual([{
    type: 'sftp_upload_start',
    path: '/home/deploy/config.yml',
    size: 3,
    overwrite: false,
  }]);
  expect(beforeConfirmation.binaryChunks).toEqual([]);

  await dialog.locator('.app-dialog__button--confirm').click();
  await page.evaluate(() => (window as any).__sftpOverwriteTest.uploadPromise);

  const confirmedResult = await page.evaluate(() => {
    const testState = (window as any).__sftpOverwriteTest;
    return {
      uploadStarts: testState.frames.filter(
        (frame: Record<string, unknown>) => frame.type === 'sftp_upload_start',
      ),
      binaryChunks: [...testState.binaryChunks],
    };
  });

  expect(confirmedResult.uploadStarts).toEqual([
    {
      type: 'sftp_upload_start',
      path: '/home/deploy/config.yml',
      size: 3,
      overwrite: false,
    },
    {
      type: 'sftp_upload_start',
      path: '/home/deploy/config.yml',
      size: 3,
      overwrite: true,
    },
  ]);
  expect(confirmedResult.binaryChunks).toEqual([3]);

  await page.evaluate(() => {
    const testState = (window as any).__sftpOverwriteTest;
    testState.cancelPromise = (testState.panel as any).uploadSingleFile(
      new File(['skip'], 'cancelled.yml', { type: 'text/yaml' }),
      '/home/deploy',
    );
  });

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('cancelled.yml');
  await dialog.locator('.app-dialog__button--cancel').click();
  await page.evaluate(() => (window as any).__sftpOverwriteTest.cancelPromise);

  const cancelledResult = await page.evaluate(() => {
    const testState = (window as any).__sftpOverwriteTest;
    const output = {
      uploadStarts: testState.frames.filter(
        (frame: Record<string, unknown>) =>
          frame.type === 'sftp_upload_start' && frame.path === '/home/deploy/cancelled.yml',
      ),
      binaryChunks: [...testState.binaryChunks],
      status: document.querySelector('#sftp-status-text')?.textContent,
    };
    testState.panel.dispose();
    return output;
  });

  expect(cancelledResult.uploadStarts).toEqual([{
    type: 'sftp_upload_start',
    path: '/home/deploy/cancelled.yml',
    size: 4,
    overwrite: false,
  }]);
  expect(cancelledResult.binaryChunks).toEqual([3]);
  expect(cancelledResult.status).toBe('已取消覆盖，跳过该文件');
});
