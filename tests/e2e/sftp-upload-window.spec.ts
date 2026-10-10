import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test('隧道上传扩大初始窗口但无 ACK 时仍严格限制在 2MiB', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await page.clock.install();

  await page.evaluate(async () => {
    const { SFTPPanel } = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new SFTPPanel(() => null);
    const state = {
      panel,
      frames: [] as Array<Record<string, unknown>>,
      chunkLengths: [] as number[],
      sentBytes: 0,
      autoAck: false,
      totalBytes: 4 * 1024 * 1024,
      uploadPromise: null as Promise<boolean> | null,
    };
    (window as any).__sftpWindowTest = state;
    panel.visible = true;
    panel.sendJSON = (frame: Record<string, unknown>) => {
      state.frames.push(frame);
      if (frame.type === 'sftp_upload_start') {
        queueMicrotask(() =>
          panel.handleMessage({
            type: 'sftp_upload_ready',
            path: frame.path,
            isTunnel: true,
          })
        );
      } else if (frame.type === 'sftp_upload_end') {
        queueMicrotask(() =>
          panel.handleMessage({
            type: 'sftp_upload_complete',
            path: frame.path,
          })
        );
      }
    };
    panel.sendBinary = (data: Uint8Array) => {
      state.chunkLengths.push(data.length);
      state.sentBytes += data.length;
      if (state.autoAck) {
        const loaded = state.sentBytes;
        queueMicrotask(() =>
          panel.handleMessage({
            type: 'sftp_upload_progress',
            loaded,
            total: state.totalBytes,
          })
        );
      }
    };
    // Actual sessions advertise transport mode when the subsystem becomes ready.
    panel.handleMessage({ type: 'sftp_ready', isTunnel: true });
    state.uploadPromise = panel.uploadSingleFile(
      new File([new Uint8Array(state.totalBytes)], 'window-test.bin'),
      '/home/deploy'
    );
  });

  const sentBytes = () => page.evaluate(() => (window as any).__sftpWindowTest.sentBytes);
  await expect.poll(sentBytes).toBe(256 * 1024);

  // Timeout recovery may widen the window, but may not bypass its hard maximum.
  for (let step = 1; step <= 14; step++) {
    await page.clock.runFor(4001);
    await expect.poll(sentBytes).toBe(256 * 1024 + step * 128 * 1024);
  }
  await page.clock.runFor(8001);
  expect(await sentBytes()).toBe(2 * 1024 * 1024);
  const hasEndFrame = await page.evaluate(() =>
    (window as any).__sftpWindowTest.frames.some(
      (frame: Record<string, unknown>) => frame.type === 'sftp_upload_end'
    )
  );
  expect(hasEndFrame).toBe(false);

  // Once real progress resumes, the existing upload must complete normally.
  const result = await page.evaluate(async () => {
    const state = (window as any).__sftpWindowTest;
    state.autoAck = true;
    state.panel.handleMessage({
      type: 'sftp_upload_progress',
      loaded: state.sentBytes,
      total: state.totalBytes,
    });
    const success = await state.uploadPromise;
    const output = {
      success,
      sentBytes: state.sentBytes,
      chunkLengths: state.chunkLengths,
      endFrames: state.frames.filter(
        (frame: Record<string, unknown>) => frame.type === 'sftp_upload_end'
      ),
    };
    state.panel.dispose();
    return output;
  });
  expect(result.success).toBe(true);
  expect(result.sentBytes).toBe(4 * 1024 * 1024);
  expect(result.chunkLengths).toHaveLength(128);
  expect(result.chunkLengths.every((length: number) => length === 32 * 1024)).toBe(true);
  expect(result.endFrames).toHaveLength(1);
  expect(result.endFrames[0].expectedHash).toMatch(/^[a-f0-9]{64}$/);
});
