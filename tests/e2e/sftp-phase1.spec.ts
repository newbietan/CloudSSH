import { expect, test, type Page } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

function makeEntry(name: string, size: number, mtime: number, isDir = false): Record<string, unknown> {
  return {
    name,
    type: isDir ? 'dir' : 'file',
    size,
    sizeFormatted: `${size} B`,
    permissions: isDir ? 'drwxr-xr-x' : '-rw-r--r--',
    permissionsRaw: isDir ? 0o40755 : 0o100644,
    modifiedTime: mtime,
    isDir,
    isLink: false,
  };
}

async function mountPanel(page: Page, path: string, entries: Array<Record<string, unknown>>): Promise<void> {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await page.evaluate(
    async ({ initialPath, initialEntries }: { initialPath: string; initialEntries: Array<Record<string, unknown>> }) => {
      const sftpModule = await (window as any).eval("import('/src/sftp-panel.ts')");
      const panel = new sftpModule.SFTPPanel(() => null);
      panel.bindEvents();
      panel.show();
      (panel as any).sftpReady = true;
      const frames: Array<Record<string, unknown>> = [];
      (window as any).__sftpFrames = frames;
      (panel as any).sendJSON = (frame: Record<string, unknown>) => {
        frames.push(frame);
      };
      (panel as any).onListResult(initialPath, initialEntries);
      (window as any).__sftpPanel = panel;
    },
    { initialPath: path, initialEntries: entries }
  );
  await page.waitForSelector('#sftp-panel');
}

test.describe('SFTP 第一阶段功能 E2E', () => {
  test('路径面包屑导航正常渲染并可点击直达', async ({ page }) => {
    const entries = [makeEntry('nginx.conf', 100, 1000)];
    await mountPanel(page, '/var/log/nginx', entries);

    // 面包屑容器渲染各级节点
    const breadcrumbs = page.locator('#sftp-breadcrumbs .sftp-crumb-item');
    await expect(breadcrumbs).toHaveCount(4); // [/], [var], [log], [nginx]

    // 点击 /var 节点，应发送 sftp_list 到 /var
    const varCrumb = page.locator('#sftp-breadcrumbs .sftp-crumb-item[data-path="/var"]');
    await expect(varCrumb).toHaveCount(1);
    await varCrumb.click();

    const frames = await page.evaluate(() => (window as any).__sftpFrames);
    const listFrame = frames.find((f: any) => f.type === 'sftp_list' && f.path === '/var');
    expect(listFrame).toBeDefined();
  });

  test('表头点击可按大小和修改时间排序', async ({ page }) => {
    const entries = [
      makeEntry('small.txt', 10, 3000),
      makeEntry('large.txt', 1000, 1000),
      makeEntry('medium.txt', 100, 2000),
    ];
    await mountPanel(page, '/home', entries);

    // 默认按名称升序排列
    let names = await page.locator('.sftp-entry').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-name'))
    );
    expect(names).toEqual(['large.txt', 'medium.txt', 'small.txt']);

    // 点击“大小”表头排序 -> 默认 desc（大文件在前）
    await page.locator('#sftp-sort-size').click();
    names = await page.locator('.sftp-entry').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-name'))
    );
    expect(names).toEqual(['large.txt', 'medium.txt', 'small.txt']);

    // 再次点击“大小”表头 -> asc（小文件在前）
    await page.locator('#sftp-sort-size').click();
    names = await page.locator('.sftp-entry').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-name'))
    );
    expect(names).toEqual(['small.txt', 'medium.txt', 'large.txt']);

    // 点击“修改时间”表头 -> 默认 desc（最新在前：3000 -> 2000 -> 1000）
    await page.locator('#sftp-sort-mtime').click();
    names = await page.locator('.sftp-entry').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-name'))
    );
    expect(names).toEqual(['small.txt', 'medium.txt', 'large.txt']);
  });

  test('点击新建文件按钮呼出创建文件弹窗', async ({ page }) => {
    const entries = [makeEntry('test.txt', 50, 1000)];
    await mountPanel(page, '/home', entries);

    await page.click('#sftp-new-file-btn');
    // 应当弹出输入框对话框
    const dialog = page.locator('dialog.app-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('新建文件');
  });
});
