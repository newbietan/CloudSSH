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
        queueMicrotask(() =>
          panel.handleMessage({
            type: 'sftp_upload_conflict',
            path: frame.path,
            existingSize: 2048,
          })
        );
      } else if (frame.type === 'sftp_upload_start' && frame.overwrite === true) {
        queueMicrotask(() => panel.handleMessage({ type: 'sftp_upload_ready', path: frame.path }));
      } else if (frame.type === 'sftp_upload_end') {
        queueMicrotask(() =>
          panel.handleMessage({
            type: 'sftp_upload_complete',
            path: '/home/deploy/config.yml',
          })
        );
      }
    };
    (panel as any).sendBinary = (data: Uint8Array) => {
      binaryChunks.push(data.length);
      queueMicrotask(() =>
        panel.handleMessage({
          type: 'sftp_upload_progress',
          loaded: data.length,
          total: data.length,
        })
      );
    };

    const uploadPromise = (panel as any).uploadSingleFile(
      new File(['new'], 'config.yml', { type: 'text/yaml' }),
      '/home/deploy'
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
        (frame: Record<string, unknown>) => frame.type === 'sftp_upload_start'
      ),
      binaryChunks: [...testState.binaryChunks],
    };
  });
  expect(beforeConfirmation.uploadStarts).toEqual([
    {
      type: 'sftp_upload_start',
      path: '/home/deploy/config.yml',
      size: 3,
      overwrite: false,
    },
  ]);
  expect(beforeConfirmation.binaryChunks).toEqual([]);

  await dialog.locator('.app-dialog__button--confirm').click();
  await page.evaluate(() => (window as any).__sftpOverwriteTest.uploadPromise);

  const confirmedResult = await page.evaluate(() => {
    const testState = (window as any).__sftpOverwriteTest;
    return {
      uploadStarts: testState.frames.filter(
        (frame: Record<string, unknown>) => frame.type === 'sftp_upload_start'
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
      '/home/deploy'
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
          frame.type === 'sftp_upload_start' && frame.path === '/home/deploy/cancelled.yml'
      ),
      binaryChunks: [...testState.binaryChunks],
      status: document.querySelector('#sftp-status-text')?.textContent,
    };
    testState.panel.dispose();
    return output;
  });

  expect(cancelledResult.uploadStarts).toEqual([
    {
      type: 'sftp_upload_start',
      path: '/home/deploy/cancelled.yml',
      size: 4,
      overwrite: false,
    },
  ]);
  expect(cancelledResult.binaryChunks).toEqual([3]);
  expect(cancelledResult.status).toBe('已取消覆盖，跳过该文件');
});

test('SFTP 支持断点续传：检测到远端未完成文件时从 offset 继续并仅发送剩余分片', async ({ page }) => {
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
      if (frame.type === 'sftp_upload_start' && !frame.overwrite && !frame.resumeOffset) {
        queueMicrotask(() =>
          panel.handleMessage({
            type: 'sftp_upload_conflict',
            path: frame.path,
            existingSize: 200,
          })
        );
      } else if (frame.type === 'sftp_upload_start') {
        queueMicrotask(() => panel.handleMessage({ type: 'sftp_upload_ready', path: frame.path }));
      } else if (frame.type === 'sftp_upload_end') {
        queueMicrotask(() =>
          panel.handleMessage({
            type: 'sftp_upload_complete',
            path: frame.path,
            size: 500,
            hash: frame.expectedHash,
            hashMatch: true,
          })
        );
      }
    };
    (panel as any).sendBinary = (data: Uint8Array) => {
      binaryChunks.push(data.length);
      queueMicrotask(() =>
        panel.handleMessage({
          type: 'sftp_upload_progress',
          loaded: 200 + binaryChunks.reduce((a, b) => a + b, 0),
          total: 500,
        })
      );
    };

    (window as any).__sftpResumeTest = {
      panel,
      frames,
      binaryChunks,
      uploadPromise: (panel as any).uploadSingleFile(
        new File([new Uint8Array(500).fill(65)], 'partial.bin', { type: 'application/octet-stream' }),
        '/home/deploy'
      ),
    };
  });

  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('发现未完成的文件');
  await expect(dialog).toContainText('40%');

  // 点击“断点续传”按钮
  await dialog.locator('.app-dialog__button--confirm').click();
  await page.evaluate(() => (window as any).__sftpResumeTest.uploadPromise);

  const result = await page.evaluate(() => {
    const testState = (window as any).__sftpResumeTest;
    const output = {
      uploadStarts: testState.frames.filter(
        (frame: Record<string, unknown>) => frame.type === 'sftp_upload_start'
      ),
      binaryTotalBytes: testState.binaryChunks.reduce((a: number, b: number) => a + b, 0),
    };
    testState.panel.dispose();
    return output;
  });

  expect(result.uploadStarts).toEqual([
    {
      type: 'sftp_upload_start',
      path: '/home/deploy/partial.bin',
      size: 500,
      overwrite: false,
    },
    {
      type: 'sftp_upload_start',
      path: '/home/deploy/partial.bin',
      size: 500,
      overwrite: false,
      resumeOffset: 200,
    },
  ]);

  // 仅发送了剩余的 300 字节，前 200 字节未重复发送！
  expect(result.binaryTotalBytes).toBe(300);
});
