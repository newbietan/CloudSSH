import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

/**
 * SFTP 操作栏布局回归：
 * 面板宽度恒定 ≤420px，6 个操作按钮（上传/新建/下载/编辑/删除/重命名）
 * 在空间不足时必须横向滚动而不是压缩换行——WebKit 对嵌套 flex 的内在
 * 尺寸计算会把 CJK 标签压成单字竖排（Issue 反馈：按钮文字竖着显示），
 * 故以 white-space: nowrap 全局禁止，并用标签高度断言守护。
 */
async function openPanel(page: import('@playwright/test').Page): Promise<void> {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await page.evaluate(async () => {
    const m = await (window as any).eval("import('/src/sftp-panel.ts')");
    const panel = new m.SFTPPanel(() => null);
    panel.visible = true;
  });
  await page.waitForSelector('.sftp-panel-actions');
}

async function measureActions(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.sftp-panel-actions')!;
    const labels = [...bar.querySelectorAll<HTMLElement>('button > span[data-i18n]')];
    const buttons = [...bar.querySelectorAll<HTMLElement>(':scope > button')];
    return {
      labelCount: labels.length,
      maxLabelHeight: Math.max(...labels.map((el) => el.getBoundingClientRect().height)),
      maxButtonHeight: Math.max(...buttons.map((el) => el.getBoundingClientRect().height)),
      overflowX: getComputedStyle(bar).overflowX,
      barScrollWidth: bar.scrollWidth,
      barClientWidth: bar.clientWidth,
    };
  });
}

test.describe('桌面视口', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('操作栏按钮单行不换行，面板宽度有界弹性', async ({ page }) => {
    await openPanel(page);
    const layout = await measureActions(page);

    expect(layout.labelCount).toBe(6);
    // 单行 11px 标签高度约 16px；两行 CJK 断行会 ≥32px
    expect(layout.maxLabelHeight).toBeLessThan(24);
    expect(layout.maxButtonHeight).toBeLessThan(40);
    expect(layout.overflowX).toBe('auto');
    // 面板宽度 clamp(420px, 40vw, 600px)：1280 视口下应为 512px
    const panelWidth = await page.evaluate(() =>
      Math.round(document.getElementById('sftp-panel')!.getBoundingClientRect().width)
    );
    expect(panelWidth).toBe(512);
  });
});

test.describe('移动端视口', () => {
  test.use({ viewport: { width: 415, height: 750 }, hasTouch: true });

  test('窄屏操作栏按钮单行、整栏可横向滚动', async ({ page }) => {
    await openPanel(page);
    const layout = await measureActions(page);

    expect(layout.labelCount).toBe(6);
    expect(layout.maxLabelHeight).toBeLessThan(24);
    // 移动端媒体查询给按钮 min-height: 40px 触摸目标
    expect(layout.maxButtonHeight).toBeGreaterThanOrEqual(40);
    expect(layout.maxButtonHeight).toBeLessThan(56);
    expect(layout.overflowX).toBe('auto');
    // 6 个按钮总宽超出 415px 视口，必须可滚动且不换行
    expect(layout.barScrollWidth).toBeGreaterThan(layout.barClientWidth);
  });
});
