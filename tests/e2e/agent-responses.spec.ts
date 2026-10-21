import { expect, test } from './fixtures';
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

test('late memory updates do not erase an interrupted task draft', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__responsesAgent;
    panel.sendMessage('Interrupted inspection');
    const requestId = sent.at(-1).requestId;
    panel.handleAgentFrame({ subType: 'run_start', requestId, runId: 1 });
    panel.handleAgentFrame({ subType: 'run_end', requestId, runId: 1, outcome: 'failed' });
  });
  const before = await page.evaluate(() => localStorage.getItem('cloudssh_agent_draft_1'));
  expect(before).not.toBeNull();
  await page.evaluate(() => (window as any).__responsesAgent.panel.handleAgentFrame({ subType: 'memory_updated' }));
  expect(await page.evaluate(() => localStorage.getItem('cloudssh_agent_draft_1'))).toBe(before);
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

test('chat shows short errors without technical diagnostics or provider text', async ({ page }) => {
  await mount(page, 'en-US');
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__responsesAgent;
    panel.sendMessage('Inspect');
    const requestId = sent.at(-1).requestId;
    panel.handleAgentFrame({ subType: 'error', runId: 1, requestId, code: 'responses_http', status: 400,
      message: 'SECRET_PROVIDER_BODY', diagnostics: { purpose: 'checkpoint', stage: 'http',
        parameter: 'text.format', providerCode: 'unsupported_parameter',
        requestId: '12345678-1234-4123-8123-123456789abc', message: '<img src=x onerror="SECRET">',
        api_key: 'SECRET_KEY', upstreamRequestId: 'SECRET_HEADER' } });
    panel.handleAgentFrame({ subType: 'run_end', runId: 1, requestId, outcome: 'failed' });
  });
  const messages = page.locator('#agent-messages');
  await expect(messages).toContainText('Context compaction stopped');
  await expect(messages).toContainText('Responses API request failed (HTTP 400). Check your key, model, and provider capabilities.');
  for (const detail of ['text.format', 'unsupported_parameter', '12345678-1234-4123-8123-123456789abc']) {
    await expect(messages).not.toContainText(detail);
  }
  await expect(messages).not.toContainText('SECRET');
  await expect(messages.locator('img, script')).toHaveCount(0);
});

test('an auxiliary memory failure warns without removing the active task stream', async ({ page }) => {
  await mount(page, 'en-US');
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__responsesAgent;
    panel.sendMessage('New task');
    const requestId = sent.at(-1).requestId;
    panel.handleAgentFrame({ subType: 'stream_chunk', requestId, content: 'ACTIVE_STREAM' });
    panel.handleAgentFrame({ subType: 'memory_status', requestId, code: 'memory_failed',
      errorCode: 'responses_http', status: 500, diagnostics: { purpose: 'memory', stage: 'http',
        providerCode: 'server_error', requestId: '12345678-1234-4123-8123-123456789abc' } });
  });
  await expect(page.locator('.app-toast')).toContainText('Knowledge extraction failed');
  for (const detail of ['server_error', '12345678-1234-4123-8123-123456789abc']) {
    await expect(page.locator('.app-toast')).not.toContainText(detail);
  }
  await expect(page.locator('#agent-send-btn')).toHaveClass(/is-stopping/);
  await expect(page.locator('#agent-messages')).toContainText('ACTIVE_STREAM');
});

for (const [locale, fallback, paused] of [
  ['zh-CN', '近期对话', '安全暂停'],
  ['zh-TW', '近期對話', '安全暫停'],
  ['en-US', 'recent conversation', 'safely paused'],
]) {
  test(`context compaction local fallback and pause diagnostics are localized (${locale})`, async ({ page }) => {
    await mount(page, locale);
    await page.evaluate(() => {
      const { panel, sent } = (window as any).__responsesAgent;
      panel.sendMessage('Inspect');
      const requestId = sent.at(-1).requestId;
      panel.handleAgentFrame({ subType: 'stream_chunk', requestId, content: 'ACTIVE_CHECKPOINT_STREAM' });
      panel.handleAgentFrame({ subType: 'context_status', requestId: 'stale', compacted: true, checkpointSource: 'local' });
    });
    await expect(page.locator('.app-toast')).toHaveCount(0);
    await page.evaluate(() => {
      const { panel, sent } = (window as any).__responsesAgent;
      panel.handleAgentFrame({ subType: 'context_status', requestId: sent.at(-1).requestId, compacted: true, checkpointSource: 'local' });
    });
    await expect(page.locator('.app-toast').filter({ hasText: fallback })).toBeVisible();
    await expect(page.locator('#agent-send-btn')).toHaveClass(/is-stopping/);
    await expect(page.locator('#agent-messages')).toContainText('ACTIVE_CHECKPOINT_STREAM');
    await page.evaluate(() => {
      const { panel, sent } = (window as any).__responsesAgent;
      const requestId = sent.at(-1).requestId;
      panel.handleAgentFrame({ subType: 'error', requestId, runId: 1, code: 'responses_budget',
        message: 'SECRET_PROVIDER_BODY', diagnostics: { purpose: 'checkpoint', stage: 'http',
          requestId: '12345678-1234-4123-8123-123456789abc' } });
      panel.handleAgentFrame({ subType: 'run_end', requestId, runId: 1, outcome: 'failed' });
    });
    const messages = page.locator('#agent-messages');
    await expect(messages).toContainText(paused);
    for (const value of ['12345678-1234-4123-8123-123456789abc']) await expect(messages).not.toContainText(value);
    await expect(messages).not.toContainText('SECRET');
    await expect(page.locator('#agent-send-btn')).not.toHaveClass(/is-stopping/);
  });
}

test('model token budgets load, validate, save and reset without resending the saved API key', async ({ page }) => {
  await mockAnonymousSession(page);
  const writes: any[] = [];
  let config = { configured: true, base_url: 'https://api.example.com/v1', model: 'model-test',
    api_key_last4: 'last', context_window: 16_384, max_output_tokens: 1024 };
  await page.route('**/api/ai/config', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: config });
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON();
    writes.push(body);
    config = { ...config, ...body, context_window: body.context_window ?? 64_000,
      max_output_tokens: body.max_output_tokens ?? 8192 };
    return route.fulfill({ json: { success: true } });
  });
  await page.goto('/?lang=en-US');
  await page.evaluate(async () => {
    const module = await (window as any).eval("import('/src/ai-config.ts')");
    (window as any).__aiBudgetPanel = new module.AIConfigPanel();
    (window as any).__aiBudgetPanel.show();
  });
  await page.locator('[data-i18n="aiConfig.budgets"]').click();
  await expect(page.locator('#ai-context-window')).toHaveValue('16384');
  await expect(page.locator('#ai-max-output-tokens')).toHaveValue('1024');
  await page.locator('#ai-max-output-tokens').fill('16384');
  await page.locator('#ai-save-btn').click();
  await expect(page.locator('#ai-config-error')).toContainText('Invalid token budgets');
  expect(writes).toHaveLength(0);
  await page.locator('#ai-context-window').fill('32768');
  await page.locator('#ai-max-output-tokens').fill('2048');
  await page.locator('#ai-save-btn').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ context_window: 32_768, max_output_tokens: 2048 });
  expect(writes[0]).not.toHaveProperty('api_key');
  await expect(page.locator('#ai-config-modal')).toBeHidden();
  await page.evaluate(() => (window as any).__aiBudgetPanel.show());
  await expect(page.locator('#ai-context-window')).toHaveValue('32768');
  await page.locator('#ai-context-window').fill('');
  await page.locator('#ai-max-output-tokens').fill('');
  await page.locator('#ai-save-btn').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ context_window: null, max_output_tokens: null });
});

test('confirmation buttons and closure frames bind to one ID, even for identical commands', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    document.getElementById('terminal-section')!.classList.remove('hidden');
    const { panel } = (window as any).__responsesAgent;
    panel.handleAgentFrame({ subType: 'confirm_required', confirmationId: 'AAAAAAAAAAAAAAAA',
      command: 'rm file', reason: 'delete' });
    (window as any).__oldConfirmButton = document.querySelector('.agent-confirm-yes');
  });
  await page.locator('.agent-confirm-yes').click();
  await page.evaluate(() => {
    const { panel } = (window as any).__responsesAgent;
    panel.handleAgentFrame({ subType: 'confirm_required', confirmationId: 'BBBBBBBBBBBBBBBB',
      command: 'rm file', reason: 'delete' });
    (window as any).__oldConfirmButton.click();
    panel.handleAgentFrame({ subType: 'confirm_closed', confirmationId: 'AAAAAAAAAAAAAAAA' });
  });
  await expect(page.locator('.agent-confirm')).toHaveCount(1);
  await page.locator('.agent-confirm-yes').click();
  const replies = await page.evaluate(() => (window as any).__responsesAgent.sent
    .filter((frame: any) => frame.type === 'agent_confirm'));
  expect(replies).toEqual([
    { type: 'agent_confirm', confirmationId: 'AAAAAAAAAAAAAAAA', approved: true, command: 'rm file' },
    { type: 'agent_confirm', confirmationId: 'BBBBBBBBBBBBBBBB', approved: true, command: 'rm file' },
  ]);
});

test('a queued old auto-confirm callback cannot approve or cancel the new timer', async ({ page }) => {
  await page.clock.install();
  await mount(page);
  await page.evaluate(() => {
    document.getElementById('terminal-section')!.classList.remove('hidden');
    const { panel } = (window as any).__responsesAgent;
    panel.agentMode = 'auto';
    const original = window.setTimeout;
    let oldTimer: (() => void) | undefined;
    window.setTimeout = ((fn: any, delay: number, ...args: any[]) => {
      if (delay === 3000 && !oldTimer) oldTimer = fn;
      return original(fn, delay, ...args);
    }) as typeof window.setTimeout;
    const frame = { subType: 'confirm_required', command: 'rm file', reason: 'delete' };
    panel.handleAgentFrame({ ...frame, confirmationId: 'AAAAAAAAAAAAAAAA' });
    panel.handleAgentFrame({ ...frame, confirmationId: 'BBBBBBBBBBBBBBBB' });
    oldTimer!();
    window.setTimeout = original;
    if (panel.autoConfirmTimer === null) throw new Error('Old callback cancelled current timer');
  });
  await page.clock.runFor(3000);
  const approvals = await page.evaluate(() => (window as any).__responsesAgent.sent
    .filter((frame: any) => frame.type === 'agent_confirm' && frame.approved));
  expect(approvals).toEqual([
    { type: 'agent_confirm', confirmationId: 'BBBBBBBBBBBBBBBB', approved: true, command: 'rm file' },
  ]);
  await expect(page.locator('.agent-confirm')).toHaveCount(0);
});

test('missing Markdown wrapper falls back to text, never raw response HTML', async ({ page }) => {
  await mount(page);
  const attack = '<img src=x onerror="window.__agentXss=1"><svg onload="window.__agentXss=1">';
  await page.evaluate(content => {
    const { panel } = (window as any).__responsesAgent;
    (window as any).__agentXss = 0;
    panel.handleAgentFrame({ subType: 'stream_chunk', content: 'streaming' });
    panel.renderMarkdown = () => '<p>sanitized fragment without wrapper</p>';
    panel.handleAgentFrame({ subType: 'stream_end', content });
  }, attack);
  const rendered = page.locator('.agent-response .agent-md-content');
  await expect(rendered).toHaveText(attack);
  await expect(rendered.locator('img, svg, script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__agentXss)).toBe(0);
});

test('normal Markdown still renders through DOMPurify without event attributes', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel } = (window as any).__responsesAgent;
    (window as any).__agentXss = 0;
    panel.handleAgentFrame({ subType: 'stream_chunk', content: 'streaming' });
    panel.handleAgentFrame({ subType: 'stream_end', content:
      '**safe bold** <img src=x onerror="window.__agentXss=1"><script>window.__agentXss=1</script>' });
  });
  const rendered = page.locator('.agent-response .agent-md-content');
  await expect(rendered.locator('strong')).toHaveText('safe bold');
  await expect(rendered.locator('[onerror], script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__agentXss)).toBe(0);
});

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
