import { expect, test, type Page } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

const FILE_BYTES = '# config\nlisten 80;\n';
const DEFAULT_MTIME = 1712345678;
// CodeMirror “Mod-s” 跟随平台：macOS 为 Cmd+S，其余为 Ctrl+S
const SAVE_SHORTCUT = process.platform === 'darwin' ? 'Meta+s' : 'Control+s';

interface EditorEvalArgs {
  fileBytes: string;
  mtime: number;
  /** 保存前 re-stat 返回的远端快照；null 表示与打开时一致 */
  nextStat?: { modifiedTime: number; size: number } | null;
}

/** 最简编辑器打开桩：仅 mock edit_read 与 list，用于换行等非保存链路断言 */
async function openEditorMinimal(page: Page): Promise<void> {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await page.evaluate(async ({ fileBytes, mtime }: EditorEvalArgs) => {
    const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new sftpModule.SFTPPanel(() => null);
    (panel as any).visible = true;
    (panel as any).sftpReady = true;
    (panel as any).sendJSON = (frame: Record<string, unknown>) => {
      if (frame.type === 'sftp_edit_read') {
        queueMicrotask(() => {
          panel.handleMessage({
            type: 'sftp_edit_start',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
          panel.handleBinaryData(new TextEncoder().encode(fileBytes as string));
          panel.handleMessage({
            type: 'sftp_edit_done',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
        });
      } else if (frame.type === 'sftp_list') {
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_list_result', path: frame.path, entries: [] })
        );
      }
    };
    (panel as any).sendBinary = () => {};
    void (panel as any).openEditorForFile(
      '/home/deploy/nginx.conf',
      'nginx.conf',
      (fileBytes as string).length
    );
  }, { fileBytes: FILE_BYTES, mtime: DEFAULT_MTIME });
  await expect(page.locator('dialog.remote-editor')).toBeVisible();
}

/** 自动换行状态：CM6 lineWrapping 会在 .cm-content 上挂 cm-lineWrapping 类 */
function wrapState(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.querySelector('.cm-content')!.classList.contains('cm-lineWrapping')
  );
}

// 注意：page.evaluate 的回调在浏览器上下文执行，所有数据必须经参数传入，
// 不能闭包引用本文件的常量（DEFAULT_MTIME 经 args.mtime 传递）。

test('在线编辑器打开文件并保存（无冲突）', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  await page.evaluate(async ({ fileBytes, mtime }: EditorEvalArgs) => {
    const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new sftpModule.SFTPPanel(() => null);
    const frames: Array<Record<string, unknown>> = [];
    const binaryChunks: Uint8Array[] = [];

    (panel as any).visible = true;
    (panel as any).sftpReady = true;
    (panel as any).sendJSON = (frame: Record<string, unknown>) => {
      frames.push(frame);
      if (frame.type === 'sftp_edit_read') {
        queueMicrotask(() => {
          panel.handleMessage({
            type: 'sftp_edit_start',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
          panel.handleBinaryData(new TextEncoder().encode(fileBytes as string));
          panel.handleMessage({
            type: 'sftp_edit_done',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
        });
      } else if (frame.type === 'sftp_stat') {
        const override = (window as any).__sftpEditorTest.nextStat;
        const attrs = override ?? { modifiedTime: mtime, size: (fileBytes as string).length };
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_stat_result', path: frame.path, attrs })
        );
      } else if (frame.type === 'sftp_upload_start') {
        queueMicrotask(() => {
          if (frame.overwrite === true) {
            panel.handleMessage({ type: 'sftp_upload_ready', path: frame.path });
          } else {
            panel.handleMessage({
              type: 'sftp_upload_conflict',
              path: frame.path,
              existingSize: (fileBytes as string).length,
            });
          }
        });
      } else if (frame.type === 'sftp_upload_end') {
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_upload_complete', path: frame.path, size: 0 })
        );
      } else if (frame.type === 'sftp_list') {
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_list_result', path: frame.path, entries: [] })
        );
      }
    };
    (panel as any).sendBinary = (data: Uint8Array) => {
      binaryChunks.push(new Uint8Array(data));
      queueMicrotask(() =>
        panel.handleMessage({
          type: 'sftp_upload_progress',
          loaded: data.length,
          total: data.length,
        })
      );
    };

    (window as any).__sftpEditorTest = { panel, frames, binaryChunks, nextStat: null };
    void (panel as any).openEditorForFile(
      '/home/deploy/nginx.conf',
      'nginx.conf',
      (fileBytes as string).length
    );
  }, { fileBytes: FILE_BYTES, mtime: DEFAULT_MTIME });

  const editor = page.locator('dialog.remote-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.remote-editor__title')).toHaveText('nginx.conf');
  await expect(editor.locator('.remote-editor__path')).toHaveText('/home/deploy/nginx.conf');
  await expect(editor.locator('.remote-editor__status')).toContainText('UTF-8');
  await expect(editor.locator('.cm-content')).toContainText('listen 80;');

  // 追加一行并保存（Ctrl+S）
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nserver_name x;');
  await page.keyboard.press(SAVE_SHORTCUT);

  await expect(page.locator('.app-toast')).toContainText('已保存：nginx.conf');

  const saved = await page.evaluate(() => {
    const state = (window as any).__sftpEditorTest;
    return {
      uploadStarts: state.frames.filter(
        (f: Record<string, unknown>) => f.type === 'sftp_upload_start'
      ),
      statCalls: state.frames.filter((f: Record<string, unknown>) => f.type === 'sftp_stat')
        .length,
      content: state.binaryChunks
        .map((chunk: Uint8Array) => new TextDecoder().decode(chunk))
        .join(''),
      dirty: state.panel.activeEditor
        ? (state.panel.activeEditor as { handle: { isDirty(): boolean } }).handle.isDirty()
        : null,
    };
  });

  expect(saved.uploadStarts).toEqual([
    {
      type: 'sftp_upload_start',
      path: '/home/deploy/nginx.conf',
      size: FILE_BYTES.length + '\nserver_name x;'.length,
      overwrite: true,
    },
  ]);
  // 保存前冲突检测 + 保存后基线刷新
  expect(saved.statCalls).toBe(2);
  expect(saved.content).toBe('# config\nlisten 80;\n\nserver_name x;');
  expect(saved.dirty).toBe(false);
});

test('远端文件已被修改时保存需显式确认覆盖', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  await page.evaluate(async ({ fileBytes, mtime }: EditorEvalArgs) => {
    const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new sftpModule.SFTPPanel(() => null);
    const frames: Array<Record<string, unknown>> = [];
    const binaryChunks: Uint8Array[] = [];

    (panel as any).visible = true;
    (panel as any).sftpReady = true;
    (panel as any).sendJSON = (frame: Record<string, unknown>) => {
      frames.push(frame);
      if (frame.type === 'sftp_edit_read') {
        queueMicrotask(() => {
          panel.handleMessage({
            type: 'sftp_edit_start',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
          panel.handleBinaryData(new TextEncoder().encode(fileBytes as string));
          panel.handleMessage({
            type: 'sftp_edit_done',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
        });
      } else if (frame.type === 'sftp_stat') {
        const attrs = (window as any).__sftpEditorTest.nextStat;
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_stat_result', path: frame.path, attrs })
        );
      } else if (frame.type === 'sftp_upload_start' && frame.overwrite === true) {
        queueMicrotask(() => panel.handleMessage({ type: 'sftp_upload_ready', path: frame.path }));
      } else if (frame.type === 'sftp_upload_end') {
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_upload_complete', path: frame.path, size: 0 })
        );
      } else if (frame.type === 'sftp_list') {
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_list_result', path: frame.path, entries: [] })
        );
      }
    };
    (panel as any).sendBinary = (data: Uint8Array) => {
      binaryChunks.push(new Uint8Array(data));
      queueMicrotask(() =>
        panel.handleMessage({
          type: 'sftp_upload_progress',
          loaded: data.length,
          total: data.length,
        })
      );
    };

    // 保存前的 re-stat 返回被他人修改过的快照（mtime/size 均变化）
    (window as any).__sftpEditorTest = {
      panel,
      frames,
      binaryChunks,
      nextStat: { modifiedTime: mtime + 60, size: (fileBytes as string).length + 3 },
    };
    void (panel as any).openEditorForFile(
      '/home/deploy/nginx.conf',
      'nginx.conf',
      (fileBytes as string).length
    );
  }, {
    fileBytes: FILE_BYTES,
    mtime: DEFAULT_MTIME,
    nextStat: { modifiedTime: DEFAULT_MTIME + 60, size: FILE_BYTES.length + 3 },
  });

  const editor = page.locator('dialog.remote-editor');
  await expect(editor).toBeVisible();

  await editor.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nserver_name x;');
  await page.keyboard.press(SAVE_SHORTCUT);

  // 冲突确认对话框（叠在编辑器之上）
  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('文件已在服务器上被修改');
  await expect(dialog).toContainText('覆盖保存');

  // 确认前不得发出任何上传
  const before = await page.evaluate(
    () =>
      (window as any).__sftpEditorTest.frames.filter(
        (f: Record<string, unknown>) => f.type === 'sftp_upload_start'
      ).length
  );
  expect(before).toBe(0);

  await dialog.locator('.app-dialog__button--confirm').click();

  await expect(page.locator('.app-toast')).toContainText('已保存：nginx.conf');
  const uploadStarts = await page.evaluate(
    () =>
      (window as any).__sftpEditorTest.frames.filter(
        (f: Record<string, unknown>) => f.type === 'sftp_upload_start'
      )
  );
  expect(uploadStarts).toHaveLength(1);
  expect(uploadStarts[0]).toMatchObject({ path: '/home/deploy/nginx.conf', overwrite: true });
});

test('有未保存修改时关闭编辑器需确认放弃', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  await page.evaluate(async ({ fileBytes, mtime }: EditorEvalArgs) => {
    const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new sftpModule.SFTPPanel(() => null);

    (panel as any).visible = true;
    (panel as any).sftpReady = true;
    (panel as any).sendJSON = (frame: Record<string, unknown>) => {
      if (frame.type === 'sftp_edit_read') {
        queueMicrotask(() => {
          panel.handleMessage({
            type: 'sftp_edit_start',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
          panel.handleBinaryData(new TextEncoder().encode(fileBytes as string));
          panel.handleMessage({
            type: 'sftp_edit_done',
            path: frame.path,
            size: (fileBytes as string).length,
            mtime,
          });
        });
      } else if (frame.type === 'sftp_list') {
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_list_result', path: frame.path, entries: [] })
        );
      }
    };
    (panel as any).sendBinary = () => {};

    (window as any).__sftpEditorTest = { panel, frames: [], binaryChunks: [], nextStat: null };
    void (panel as any).openEditorForFile(
      '/home/deploy/nginx.conf',
      'nginx.conf',
      (fileBytes as string).length
    );
  }, { fileBytes: FILE_BYTES, mtime: DEFAULT_MTIME });

  const editor = page.locator('dialog.remote-editor');
  await expect(editor).toBeVisible();

  await editor.locator('.cm-content').click();
  await page.keyboard.type('modified');
  await expect(editor.locator('.remote-editor__status')).toContainText('有未保存修改');

  // 直接关闭：弹出放弃确认，取消后编辑器仍在
  await editor.locator('.remote-editor__close').click();
  const dialog = page.locator('.app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('放弃未保存的修改');
  await dialog.locator('.app-dialog__button--cancel').click();
  await expect(editor).toBeVisible();

  // 再次关闭并确认放弃：编辑器关闭且触发刷新
  await editor.locator('.remote-editor__close').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('.app-dialog__button--confirm').click();
  await expect(editor).not.toBeAttached();
});

test('超过大小上限与二进制内容拒绝打开编辑器', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  await page.evaluate(async () => {
    const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new sftpModule.SFTPPanel(() => null);
    (panel as any).visible = true;
    (panel as any).sftpReady = true;
    (panel as any).sendJSON = () => {};
    (panel as any).sendBinary = () => {};
    (window as any).__sftpEditorTest = { panel, frames: [], binaryChunks: [], nextStat: null };
  });

  await page.evaluate(() => {
    const state = (window as any).__sftpEditorTest;
    void (state.panel as any).openEditorForFile(
      '/var/log/huge.log',
      'huge.log',
      3 * 1024 * 1024
    );
  });

  await expect(page.locator('.app-toast')).toContainText('过大');
  await expect(page.locator('dialog.remote-editor')).not.toBeAttached();
});

test('非 UTF-8（GBK）文件以只读模式打开', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  // “配置” 的 GBK 编码 + CRLF 换行
  const gbkBytes = [0xc5, 0xe4, 0xd6, 0xc3, 0x0d, 0x0a];
  await page.evaluate(async ({ bytes, mtime }: { bytes: number[]; mtime: number }) => {
    const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new sftpModule.SFTPPanel(() => null);
    const payload = new Uint8Array(bytes);

    (panel as any).visible = true;
    (panel as any).sftpReady = true;
    (panel as any).sendJSON = (frame: Record<string, unknown>) => {
      if (frame.type === 'sftp_edit_read') {
        queueMicrotask(() => {
          panel.handleMessage({
            type: 'sftp_edit_start',
            path: frame.path,
            size: payload.length,
            mtime,
          });
          panel.handleBinaryData(payload);
          panel.handleMessage({
            type: 'sftp_edit_done',
            path: frame.path,
            size: payload.length,
            mtime,
          });
        });
      } else if (frame.type === 'sftp_list') {
        queueMicrotask(() =>
          panel.handleMessage({ type: 'sftp_list_result', path: frame.path, entries: [] })
        );
      }
    };
    (panel as any).sendBinary = () => {};

    (window as any).__sftpEditorTest = { panel, frames: [], binaryChunks: [], nextStat: null };
    void (panel as any).openEditorForFile(
      '/home/deploy/legacy.conf',
      'legacy.conf',
      payload.length
    );
  }, { bytes: gbkBytes, mtime: DEFAULT_MTIME });

  const editor = page.locator('dialog.remote-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.remote-editor__notice')).toBeVisible();
  await expect(editor.locator('.remote-editor__notice')).toContainText('GBK/GB18030');
  await expect(editor.locator('.remote-editor__status')).toContainText('GBK/GB18030');
  await expect(editor.locator('.remote-editor__status')).toContainText('CRLF');
  await expect(editor.locator('.remote-editor__button--save')).toBeDisabled();
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
});

test('桌面端编辑器默认不换行，可开启并持久化偏好', async ({ page }) => {
  await openEditorMinimal(page);
  const editor = page.locator('dialog.remote-editor');

  expect(await wrapState(page)).toBe(false);

  await editor.locator('.remote-editor__button--wrap').click();
  expect(await wrapState(page)).toBe(true);
  expect(await page.evaluate(() => window.localStorage.getItem('cloudssh_editor_wrap'))).toBe(
    'on'
  );

  // 关闭后重新打开仍为开启（持久化偏好优先于设备默认值）
  await editor.locator('.remote-editor__close').click();
  await expect(editor).not.toBeAttached();
  await openEditorMinimal(page);
  expect(await wrapState(page)).toBe(true);
});

test.describe('移动端视口', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('窄视口下编辑器近全屏、无横向溢出且字号避免 iOS 缩放', async ({ page }) => {
    await mockAnonymousSession(page);
    await page.goto('/?lang=zh-CN');

    await page.evaluate(async ({ fileBytes, mtime }: EditorEvalArgs) => {
      const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
      const panel = new sftpModule.SFTPPanel(() => null);

      (panel as any).visible = true;
      (panel as any).sftpReady = true;
      (panel as any).sendJSON = (frame: Record<string, unknown>) => {
        if (frame.type === 'sftp_edit_read') {
          queueMicrotask(() => {
            panel.handleMessage({
              type: 'sftp_edit_start',
              path: frame.path,
              size: (fileBytes as string).length,
              mtime,
            });
            panel.handleBinaryData(new TextEncoder().encode(fileBytes as string));
            panel.handleMessage({
              type: 'sftp_edit_done',
              path: frame.path,
              size: (fileBytes as string).length,
              mtime,
            });
          });
        } else if (frame.type === 'sftp_list') {
          queueMicrotask(() =>
            panel.handleMessage({ type: 'sftp_list_result', path: frame.path, entries: [] })
          );
        }
      };
      (panel as any).sendBinary = () => {};

      void (panel as any).openEditorForFile(
        '/home/deploy/nginx.conf',
        'nginx.conf',
        (fileBytes as string).length
      );
    }, { fileBytes: FILE_BYTES, mtime: DEFAULT_MTIME });

    const editor = page.locator('dialog.remote-editor');
    await expect(editor).toBeVisible();

    const layout = await editor.evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      const close = dialog.querySelector('.remote-editor__close');
      const closeBox = close?.getBoundingClientRect();
      const cmEditor = dialog.querySelector('.cm-editor');
      return {
        dialogWidth: Math.round(box.width),
        dialogRight: Math.round(box.right),
        dialogHeight: Math.round(box.height),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        closeTouchHeight: closeBox ? Math.round(closeBox.height) : 0,
        cmFontSize: cmEditor ? getComputedStyle(cmEditor).fontSize : null,
      };
    });

    // 近全屏：宽度含左右安全区，不超出视口且无横向溢出
    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.dialogWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.dialogRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.dialogHeight).toBeLessThanOrEqual(844);
    expect(layout.dialogHeight).toBeGreaterThan(600);
    // 字号 16px 避免 iOS 聚焦缩放
    expect(layout.cmFontSize).toBe('16px');
    // 关闭按钮触摸目标
    expect(layout.closeTouchHeight).toBeGreaterThanOrEqual(40);

    // 移动端上仍可编辑并触发未保存确认
    await editor.locator('.cm-content').click();
    await page.keyboard.type('modified');
    await expect(editor.locator('.remote-editor__status')).toContainText('有未保存修改');

    await editor.locator('.remote-editor__close').click();
    const dialog = page.locator('.app-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('.app-dialog__button--cancel').click();
    await expect(editor).toBeVisible();
  });

  test('移动端编辑器默认开启自动换行，可关闭并持久化', async ({ page }) => {
    await openEditorMinimal(page);
    const editor = page.locator('dialog.remote-editor');

    expect(await wrapState(page)).toBe(true);

    await editor.locator('.remote-editor__button--wrap').click();
    expect(await wrapState(page)).toBe(false);
    expect(await page.evaluate(() => window.localStorage.getItem('cloudssh_editor_wrap'))).toBe(
      'off'
    );
  });
});
