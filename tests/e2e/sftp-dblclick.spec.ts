import { expect, test, type Page } from './fixtures';
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
  initialPath?: string;
  target?: { type: 'dir' | 'file'; size: number } | 'error' | 'pending';
  action?: 'dblclick' | 'contextOpen' | 'edit' | 'none';
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

function linkEntry(name: string): Record<string, unknown> {
  return {
    ...fileEntry(name, 9), type: 'link', isLink: true,
    permissions: 'lrwxrwxrwx', permissionsRaw: 0o120777,
  };
}

async function getFrames(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as any).__sftpFrames);
}

async function waitForDownload(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    (window as any).__sftpFrames.some((frame: { type: string }) => frame.type === 'sftp_download')
  );
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
      (panel as any).container.style.transform = 'translateX(0)';
      panel.bindEvents();
      (window as any).__sftpPanel = panel;
      const frames: Array<Record<string, unknown>> = [];
      (window as any).__sftpFrames = frames;
      (panel as any).sendJSON = (frame: Record<string, unknown>) => {
        frames.push(frame);
        if (frame.type === 'sftp_list') {
          queueMicrotask(() =>
            panel.handleMessage({
              type: 'sftp_list_result',
              path: frame.path === '~' ? cfg.initialPath || '/home' : frame.path,
              entries: cfg.entries,
            })
          );
        } else if (frame.type === 'sftp_stat' && cfg.target && cfg.target !== 'pending') {
          const target = cfg.target;
          queueMicrotask(() => panel.handleMessage(target === 'error'
            ? { type: 'sftp_error', operation: 'stat', requestId: frame.requestId,
                message: 'No such file or permission denied' }
            : { type: 'sftp_stat_result', path: frame.path, requestId: frame.requestId,
                attrs: target }));
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
  if (config.action === 'none') return;
  await page.evaluate(({ clickName, action }) => {
    const entry = Array.from(
      document.querySelectorAll<HTMLElement>('#sftp-entries .sftp-entry')
    ).find((node) => node.dataset['name'] === clickName);
    const eventType = action === 'contextOpen' ? 'contextmenu'
      : action === 'edit' ? 'click' : 'dblclick';
    entry?.dispatchEvent(new MouseEvent(eventType, { bubbles: true }));
  }, { clickName: config.clickName, action: config.action });
  if (config.action === 'contextOpen') {
    await page.locator('#sftp-context-menu > div').first().click();
  }
  if (config.action === 'edit') await page.locator('#sftp-edit-btn').click();
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

for (const [initialPath, name] of [['/', 'bin'], ['/root', 'to_dir'], ['/root', 'relative']]) {
  test(`目录软链接 ${initialPath}/${name} → 按需 STAT 并保留逻辑路径`, async ({ page }) => {
    await mountAndDblclick(page, {
      initialPath, entries: [linkEntry(name)], clickName: name,
      target: { type: 'dir', size: 4096 },
    });
    const path = initialPath === '/' ? `/${name}` : `${initialPath}/${name}`;
    await expect(page.locator('#sftp-path-input')).toHaveValue(path);
    const frames = await getFrames(page);
    expect(frames.filter((frame) => frame.type === 'sftp_stat')).toEqual([
      expect.objectContaining({ path, requestId: expect.any(String) }),
    ]);
    expect(frames.some((frame) =>
      frame.type === 'sftp_edit_read' || frame.type === 'sftp_download'
    )).toBe(false);
    await page.locator('#sftp-back-btn').click();
    await expect(page.locator('#sftp-path-input')).toHaveValue(initialPath);
  });
}

test('文本文件软链接 → 以链接路径打开编辑器', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [linkEntry('config-link')], clickName: 'config-link', editRead: 'ok',
    target: { type: 'file', size: TEXT_BYTES.length },
  });
  await expect(page.locator('dialog.remote-editor')).toBeVisible();
  const frames = await getFrames(page);
  expect(frames.find((frame) => frame.type === 'sftp_edit_read')).toMatchObject({
    path: '/home/config-link',
  });
});

test('大文件软链接 → 使用目标大小而非链接长度，直接进入串行下载', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [linkEntry('big-link')], clickName: 'big-link',
    target: { type: 'file', size: 3 * 1024 * 1024 },
  });
  await waitForDownload(page);
  const frames = await getFrames(page);
  expect(frames.some((frame) => frame.type === 'sftp_edit_read')).toBe(false);
  expect(frames.find((frame) => frame.type === 'sftp_download')).toMatchObject({
    path: '/home/big-link',
  });
});

test('二进制文件软链接 → 编辑判定后回退串行下载', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [linkEntry('binary-link')], clickName: 'binary-link', editRead: 'binary',
    target: { type: 'file', size: 100 },
  });
  await waitForDownload(page);
  const frames = await getFrames(page);
  expect(frames.find((frame) => frame.type === 'sftp_edit_read')).toMatchObject({
    path: '/home/binary-link',
  });
  expect(frames.find((frame) => frame.type === 'sftp_download')).toMatchObject({
    path: '/home/binary-link',
  });
});

test('失效/无权限软链接 → 明确提示，不能误编辑或下载', async ({ page }) => {
  await mountAndDblclick(page, {
    entries: [linkEntry('broken')], clickName: 'broken', target: 'error',
  });
  await expect(page.locator('#sftp-panel')).toContainText('无法访问软链接目标');
  const frames = await getFrames(page);
  expect(frames.some((frame) =>
    frame.type === 'sftp_edit_read' || frame.type === 'sftp_download'
  )).toBe(false);
  await expect(page.locator('#sftp-path-input')).toHaveValue('/home');
});

for (const action of ['contextOpen', 'edit'] as const) {
  test(`${action} 入口同样按目标类型打开目录软链接`, async ({ page }) => {
    await mountAndDblclick(page, {
      entries: [linkEntry('to_dir')], clickName: 'to_dir', action,
      target: { type: 'dir', size: 4096 },
    });
    await expect(page.locator('#sftp-path-input')).toHaveValue('/home/to_dir');
  });
}

test('解析过的目录软链接仍按链接删除，绝不能递归删除目标', async ({ page }) => {
  await mountAndDblclick(page, {
    initialPath: '/root', entries: [linkEntry('to_dir')], clickName: 'to_dir',
    target: { type: 'dir', size: 4096 },
  });
  await expect(page.locator('#sftp-path-input')).toHaveValue('/root/to_dir');
  await page.locator('#sftp-back-btn').click();
  await expect(page.locator('#sftp-path-input')).toHaveValue('/root');
  await page.locator('.sftp-entry[data-name="to_dir"]').click();
  await page.locator('#sftp-delete-btn').click();
  await page.locator('dialog').getByRole('button', { name: '删除', exact: true }).click();
  const frames = await getFrames(page);
  expect(frames.find((frame) => frame.type === 'sftp_delete')).toMatchObject({
    path: '/root/to_dir',
  });
  expect(frames.some((frame) => frame.type === 'sftp_rmdir')).toBe(false);
  const entry = await page.evaluate(() => (window as any).__sftpPanel.entries[0]);
  expect(entry).toMatchObject({ type: 'link', isLink: true, isDir: false });
});

for (const action of ['navigate', 'hide', 'handleSSHReady', 'closed', 'dispose'] as const) {
  test(`${action} 后忽略软链接的迟到响应`, async ({ page }) => {
    await mountAndDblclick(page, {
      entries: [linkEntry('to_dir')], clickName: 'to_dir', target: 'pending',
    });
    const frames = await page.evaluate(async (action) => {
      const panel = (window as any).__sftpPanel;
      const frames = (window as any).__sftpFrames as Array<Record<string, unknown>>;
      const pending = frames.find(frame => frame.type === 'sftp_stat')!;
      if (action === 'navigate') panel.navigate('/elsewhere');
      else if (action === 'closed') panel.handleMessage({ type: 'sftp_closed' });
      else panel[action]();
      await Promise.resolve();
      frames.length = 0;
      panel.handleMessage({
        ...pending, type: 'sftp_stat_result', attrs: { type: 'dir', size: 0 },
      });
      await Promise.resolve();
      return frames;
    }, action);
    expect(frames).toEqual([]);
    await expect(page.locator('dialog.remote-editor')).toHaveCount(0);
  });
}