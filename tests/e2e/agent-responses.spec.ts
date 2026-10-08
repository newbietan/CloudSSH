import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

async function mount(page: import('@playwright/test').Page, locale = 'zh-CN') {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await page.goto(`/?lang=${locale}`);
  await page.evaluate(async () => {
    const module = await (window as any).eval("import('/src/agent/agent-panel.ts')");
    const root = document.createElement('div');
    root.id = 'responses-agent-test'; root.style.width = '900px'; root.style.height = '640px';
    document.body.appendChild(root);
    const panel = new module.AgentPanel(root, true);
    const sent: any[] = [];
    panel.render(); panel.show();
    panel.serverId = 1;
    panel.setWebSocketSend((data: string) => sent.push(JSON.parse(data)));
    (window as any).__responsesAgent = { panel, sent };
  });
}

test('Responses text completion does not finish the task; run_end does', async ({ page }) => {
  await mount(page);
  await page.locator('#agent-input').fill('检查服务器');
  await page.locator('#agent-send-btn').click();
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__responsesAgent;
    const requestId = sent.at(-1).requestId;
    panel.handleAgentFrame({ subType: 'run_start', runId: 1, requestId });
    panel.handleAgentFrame({ subType: 'stream_chunk', runId: 1, requestId, content: '先检查内存。' });
    panel.handleAgentFrame({ subType: 'stream_end', runId: 1, requestId, content: '先检查内存。' });
    panel.handleAgentFrame({ subType: 'memory_updated' });
  });
  await expect(page.locator('#agent-send-btn')).toHaveClass(/is-stopping/);
  expect(await page.evaluate(() => !!localStorage.getItem('cloudssh_agent_draft_1'))).toBe(true);
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__responsesAgent;
    panel.handleAgentFrame({ subType: 'run_end', runId: 1, requestId: sent.at(-1).requestId, outcome: 'completed' });
  });
  await expect(page.locator('#agent-send-btn')).not.toHaveClass(/is-stopping/);
  expect(await page.evaluate(() => localStorage.getItem('cloudssh_agent_draft_1'))).toBeNull();
});

test('replacement requests ignore stale output and stale completion', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__responsesAgent;
    panel.sendMessage('旧任务');
    const old = sent.at(-1).requestId;
    panel.sendMessage('新任务');
    panel.handleAgentFrame({ subType: 'run_end', requestId: old, outcome: 'completed' });
    panel.handleAgentFrame({ subType: 'stream_chunk', requestId: old, content: 'STALE OUTPUT' });
  });
  await expect(page.locator('#agent-send-btn')).toHaveClass(/is-stopping/);
  await expect(page.locator('#agent-messages')).not.toContainText('STALE OUTPUT');
  const ids = await page.evaluate(() => (window as any).__responsesAgent.sent.filter((frame: any) => frame.type === 'agent_start').map((frame: any) => frame.requestId));
  expect(ids[0]).not.toBe(ids[1]);
});

for (const [locale, expected] of [['zh-CN', '模型响应未完成'], ['zh-TW', '模型回應未完成'], ['en-US', 'model response is incomplete']]) {
  test(`Responses failure is localized without leaking provider text (${locale})`, async ({ page }) => {
    await mount(page, locale);
    await page.evaluate(() => {
      const { panel, sent } = (window as any).__responsesAgent;
      panel.sendMessage('Inspect');
      const requestId = sent.at(-1).requestId;
      panel.handleAgentFrame({ subType: 'error', runId: 1, requestId, code: 'responses_incomplete', message: 'SECRET_PROVIDER_BODY' });
      panel.handleAgentFrame({ subType: 'run_end', runId: 1, requestId, outcome: 'failed' });
    });
    await expect(page.locator('#agent-messages')).toContainText(expected);
    await expect(page.locator('#agent-messages')).not.toContainText('SECRET_PROVIDER_BODY');
    await expect(page.locator('#agent-send-btn')).not.toHaveClass(/is-stopping/);
  });
}

test('AI settings disclose retention and reject legacy generation addresses locally', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false } }));
  await page.goto('/?lang=en-US');
  await page.evaluate(async () => {
    const module = await (window as any).eval("import('/src/ai-config.ts')");
    new module.AIConfigPanel().show();
  });
  await expect(page.locator('[data-i18n="aiConfig.compatibleHint"]')).toContainText('Responses API');
  await expect(page.locator('[data-i18n="aiConfig.modelDiscoveryHint"]')).toContainText('does not confirm');
  await page.locator('#ai-base-url').fill('https://api.openai.com/v1/chat/completions');
  await page.locator('#ai-model').fill('gpt-test');
  await page.locator('#ai-api-key').fill('test-key');
  await page.locator('#ai-save-btn').click();
  await expect(page.locator('#ai-config-error')).toContainText('Legacy chat endpoints are not supported');
});

test('thinking box completely collapses live preview on completion even after interleaved text and tool calls', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__responsesAgent;
    panel.sendMessage('查看服务器硬件');
    const requestId = sent.at(-1).requestId;
    panel.handleAgentFrame({ subType: 'run_start', runId: 1, requestId });
    // Step 1: execute df -h
    panel.handleAgentFrame({ subType: 'executing', runId: 1, requestId, tool: 'execute_command', args: { command: 'df -h' } });
    // Interleaved text stream chunk (triggers mid-run collapse)
    panel.handleAgentFrame({ subType: 'stream_chunk', runId: 1, requestId, content: '正在分析...' });
    // Step 2: execute uname -a
    panel.handleAgentFrame({ subType: 'executing', runId: 1, requestId, tool: 'execute_command', args: { command: 'uname -a' } });
    // Final stream end and run_end
    panel.handleAgentFrame({ subType: 'stream_end', runId: 1, requestId, content: '硬件分析完成。' });
    panel.handleAgentFrame({ subType: 'run_end', runId: 1, requestId, outcome: 'completed' });
  });

  const thinkingBox = page.locator('.agent-thinking-process');
  await expect(thinkingBox).toBeVisible();
  await expect(thinkingBox).toHaveClass(/tp-done/);
  await expect(thinkingBox).not.toHaveClass(/tp-expanded/);
  // Live preview must be hidden on done
  await expect(page.locator('.tp-live-preview')).toBeHidden();
  await expect(thinkingBox.locator('.tp-status')).toContainText('已完成 3 个步骤');

  // Clicking accordion expands full history
  await thinkingBox.locator('.tp-accordion').click();
  await expect(thinkingBox).toHaveClass(/tp-expanded/);
  await expect(thinkingBox.locator('.tp-steps')).toContainText('$ df -h');
  await expect(thinkingBox.locator('.tp-steps')).toContainText('正在分析');
  await expect(thinkingBox.locator('.tp-steps')).toContainText('$ uname -a');
});
