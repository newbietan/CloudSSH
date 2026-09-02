import { expect, test, type Page } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

/**
 * 双击智能“打开”回归（AGENTS.md #32 相邻行为）：
 * 文本文件 → 在线编辑器；二进制 → 自动转下载；超大 → 直接下载；目录 → 导航。
 * 面板由桩驱动（同 sftp-editor.spec.ts 模式），帧序列记录在 window.__sftpFrames。
 */

interface DblclickConfig {
  entries: Array<Record<string, unknown>>;
  /** 'ok'：编辑读取返回文本成功；'binary'：worker 以二进制拒绝；缺省：不响应编辑读取 */
  editRead?: 'ok' | 'binary';
  clickName: string;
}

const TEXT_BYTES = 'echo hello\n';

function fileEntry(name: string, size: number): Record<string, unknown> {
  return {
    name,
    type: 'file',
    size,
    sizeFormatted: `${size} B`,
    permissions: '-rw-r--r--',
    permissionsRaw: 0o100644,
    modifiedTime: 1712345678,
    isDir: false,
    isLink: false,
  };
}

async function mountAndDblclick(page: Page, config: DblclickConfig): Promise<void> {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await page.evaluate(
    async (cfg: DblclickConfig & { text: string }) => {
      const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
      const panel = new sftpModule.SFTPPanel(() => null);
      (panel as any).visible = true;
      (panel as any).sftpReady = true;
      const frames: Array<Record<string, unknown>> = [];
      (window as any).__sftpFrames = frames;
      (panel as any).sendJSON = (frame: Record<string, unknown>) => {
        frames.push(frame);
        if (frame.type === 'sftp_list') {
          queueMicrotask(() =>
            panel.handleMessage({ type: 'sftp_list_result', path: '/home', entries: cfg.entries })
          );
        } else if (frame.type === 'sftp_edit_read' && cfg.editRead === 'ok') {
          const bytes = new TextEncoder().encode(cfg.text);
          queueMicrotask(() => {
            panel.handleMessage({
              type: 'sftp_edit_start',
              path: frame.path,
              size: bytes.length,
              mtime: 1712345678,
            });
            panel.handleBinaryData(bytes);
            panel.handleMessage({
              type: 'sftp_edit_done',
              path: frame.path,
              size: bytes.length,
              mtime: 1712345678,
            });
          });
        } else if (frame.type === 'sftp_edit_read' && cfg.editRead === 'binary') {
          queueMicrotask(() =>
            panel.handleMessage({
              type: 'sftp_error',
              operation: 'edit',
              message: '文件包含二进制内容，不支持在线编辑',
              code: 'binary',
            })
          );
        }
      };
      (panel as any).sendBinary = () => {};
      panel.handleMessage({ type: 'sftp_ready' });
    },
    { ...config, text: TEXT_BYTES }
  );
  await page.waitForSelector('#sftp-entries .sftp-entry');
  await page.evaluate((clickName: string) => {
    const entry = [...document.querySelectorAll<HTMLElement>('#sftp-entries .sftp-entry')].find(
      (node) => node.dataset['name'] === clickName
    );
    entry?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, config.clickName);
}

test('双击文本文件 → 打开在线编辑器', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [fileEntry('script.sh', TEXT_BYTES.length)],
    editRead: 'ok',
    clickName: 'script.sh',
  });
  await expect(page.locator('dialog.remote-editor')).toBeVisible();
});

test('双击二进制文件 → 自动转下载', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [fileEntry('app.bin', 1234)],
    editRead: 'binary',
    clickName: 'app.bin',
  });
  await page.waitForFunction(() =>
    (window as any).__sftpFrames.some(
      (frame: { type: string }) => frame.type === 'sftp_download'
    )
  );
  const frames = (await page.evaluate(
    () => (window as any).__sftpFrames
  )) as Array<Record<string, unknown>>;
  expect(frames.find((frame) => frame.type === 'sftp_download')).toMatchObject({
    path: '/home/app.bin',
  });
  await expect(page.locator('dialog.remote-editor')).toHaveCount(0);
});

test('双击超大文件 → 直接下载且不发起编辑读取', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [fileEntry('big.zip', 3 * 1024 * 1024)],
    clickName: 'big.zip',
  });
  await page.waitForFunction(() =>
    (window as any).__sftpFrames.some(
      (frame: { type: string }) => frame.type === 'sftp_download'
    )
  );
  const frames = (await page.evaluate(
    () => (window as any).__sftpFrames
  )) as Array<Record<string, unknown>>;
  expect(frames.some((frame) => frame.type === 'sftp_edit_read')).toBe(false);
  expect(frames.find((frame) => frame.type === 'sftp_download')).toMatchObject({
    path: '/home/big.zip',
  });
});

test('双击目录 → 导航进入', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [
      {
        name: 'logs',
        type: 'dir',
        size: 0,
        sizeFormatted: '-',
        permissions: 'drwxr-xr-x',
        permissionsRaw: 0o040755,
        modifiedTime: 1712345678,
        isDir: true,
        isLink: false,
      },
    ],
    clickName: 'logs',
  });
  await page.waitForFunction(() =>
    (window as any).__sftpFrames.some(
      (frame: { type: string; path?: string }) =>
        frame.type === 'sftp_list' && frame.path === '/home/logs'
    )
  );
  const frames = (await page.evaluate(
    () => (window as any).__sftpFrames
  )) as Array<Record<string, unknown>>;
  expect(frames.some((frame) => frame.type === 'sftp_edit_read')).toBe(false);
  expect(frames.some((frame) => frame.type === 'sftp_download')).toBe(false);
});