import { expect, test, type Page } from './fixtures';
import { mockAnonymousSession } from './helpers';

async function mount(page: Page, tabs = false) {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await page.goto('/?lang=zh-CN');
  await page.evaluate(async (withTabs) => {
    const sent: any[] = [];
    let panel: any;
    let manager: any;
    let tab: any;
    if (withTabs) {
      const module = await (window as any).eval("import('/src/tab-manager.ts')");
      const bar = document.createElement('div'); bar.id = 'recovery-tabs';
      const area = document.createElement('div'); area.id = 'recovery-area';
      area.style.cssText = 'width:900px;height:640px;position:relative';
      document.body.append(bar, area);
      manager = new module.TabManager(bar.id, area.id);
      manager.setUser(42);
      tab = manager.createTab('recovery', { host: 'ssh.example.com', port: 22, serverId: 1 });
      tab.terminal.sendWebSocketMessage = (data: string) => sent.push(JSON.parse(data));
      tab.terminal.onSessionReady(false);
      panel = tab.agentPanel;
    } else {
      const module = await (window as any).eval("import('/src/agent/agent-panel.ts')");
      panel = new module.AgentPanel(document.body, true, 1, 42);
      panel.render();
      panel.setWebSocketSend((data: string) => sent.push(JSON.parse(data)));
    }
    document.getElementById('terminal-section')?.classList.remove('hidden');
    panel.show();
    (window as any).__recovery = { panel, sent, manager, tab };
  }, tabs);
}

async function state(page: Page, overrides: Record<string, unknown> = {}) {
  await page.evaluate((extra) => {
    const { panel, sent } = (window as any).__recovery;
    const query = sent.filter((frame: any) => frame.type === 'agent_sync').at(-1);
    const request = sent.find((frame: any) => frame.type === 'agent_start');
    panel.handleAgentFrame({ subType: 'state', syncId: query.syncId, state: {
      runId: 1, requestId: request?.requestId ?? 'surviving-request', phase: 'thinking',
      iteration: 2, text: '', textId: 0, textComplete: true, textTruncated: false, ...extra,
    } });
  }, overrides);
}

test('真实 WebSocket 关闭与 session_resumed 事件驱动恢复，不重新发送原任务', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.route('**/api/servers/1/memory', route => route.fulfill({ json: { workLogs: [], knowledge: [] } }));
  await page.addInitScript(() => {
    const sockets: any[] = [];
    const sent: any[] = [];
    let requestId = '';
    let running = false;
    class RecoverySocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      binaryType = 'arraybuffer';
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      onerror: any = null;
      constructor(readonly url: string) {
        const ssh = new URL(url).pathname === '/api/ssh';
        if (ssh) sockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event('open'));
          if (!ssh) return; // Vite's HMR socket is not an SSH connection.
          if (new URL(url).searchParams.has('resume_token')) {
            this.emit({ type: 'session_resumed', resumeToken: 'rotated-token' });
          } else {
            this.emit({ type: 'session_created', sessionId: 'session:agent-recovery', resumeToken: 'resume-token' });
            this.emit({ type: 'status', event: 'shell_ready', message: 'Shell 已就绪' });
          }
        }, 0);
      }
      emit(frame: unknown) {
        if (this.readyState === 1) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
      }
      send(data: unknown) {
        if (typeof data !== 'string') return;
        let message: any;
        try { message = JSON.parse(data); } catch { return; }
        sent.push(message);
        if (message.type === 'ping') this.emit({ type: 'pong', id: message.id });
        if (message.type === 'agent_start') {
          requestId = message.requestId;
          running = true;
          this.emit({ type: 'agent_frame', subType: 'run_start', requestId, runId: 1 });
          this.emit({ type: 'agent_frame', subType: 'stream_chunk', requestId, runId: 1, textId: 1, content: 'before interruption' });
        }
        if (message.type === 'agent_stop') {
          running = false;
          this.emit({ type: 'agent_frame', subType: 'run_end', requestId, runId: 1, outcome: 'stopped' });
        }
        if (message.type === 'agent_sync') this.emit({
          type: 'agent_frame', subType: 'state', syncId: message.syncId,
          state: { runId: 1, requestId, phase: running ? 'thinking' : 'idle', iteration: 2,
            text: running ? 'before interruption + missed output' : '', textId: 1,
            textComplete: !running, textTruncated: false, ...(running ? {} : { outcome: 'stopped' }) },
        });
      }
      close(code = 1000) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        setTimeout(() => this.onclose?.(new CloseEvent('close', { code, wasClean: code === 1000 })), 0);
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: RecoverySocket });
    (window as any).__recoveryWire = { sockets, sent };
  });
  await page.goto('/?lang=zh-CN');
  await page.evaluate(async () => {
    const module = await (window as any).eval("import('/src/tab-manager.ts')");
    const bar = document.createElement('div'); bar.id = 'wire-tabs';
    const area = document.createElement('div'); area.id = 'wire-area';
    area.style.cssText = 'width:900px;height:640px;position:relative';
    document.body.append(bar, area);
    document.getElementById('terminal-section')?.classList.remove('hidden');
    const manager = new module.TabManager(bar.id, area.id);
    manager.setUser(42);
    const tab = manager.createTab('wire', { host: 'ssh.example.com', port: 22, serverId: 1 });
    await tab.terminal.connect({ host: 'ssh.example.com', port: 22, username: 'alice', password: '' });
    tab.agentPanel.show();
    (window as any).__recoveryWire.tab = tab;
    (window as any).__recoveryWire.originalPanel = tab.agentPanel;
  });
  await page.locator('#agent-input').fill('inspect');
  await page.locator('#agent-send-btn').click();
  await expect(page.locator('#agent-messages')).toContainText('before interruption');
  await page.evaluate(() => (window as any).__recoveryWire.sockets[0].close(1006));
  await expect(page.locator('#agent-messages')).toContainText('before interruption + missed output');
  const result = await page.evaluate(() => {
    const wire = (window as any).__recoveryWire;
    return { retained: wire.tab.agentPanel === wire.originalPanel,
      starts: wire.sent.filter((f: any) => f.type === 'agent_start').length,
      resumed: new URL(wire.sockets[1].url).searchParams.has('resume_token') };
  });
  expect(result).toEqual({ retained: true, starts: 1, resumed: true });
  await page.locator('#agent-send-btn').click();
  await page.locator('#agent-input').fill('next task');
  await expect(page.locator('#agent-send-btn')).toBeEnabled();
});

test('同一 SSH 恢复保留原面板，而新建 Shell 不接管旧任务', async ({ page }) => {
  await mount(page, true);
  const retained = await page.evaluate(() => {
    const { panel, sent, tab } = (window as any).__recovery;
    panel.sendMessage('检查服务器');
    const id = sent.at(-1).requestId;
    panel.handleAgentFrame({ subType: 'run_start', runId: 1, requestId: id });
    tab.terminal.onSessionClosed(new CloseEvent('close', { code: 1006 }), true);
    return tab.agentPanel === panel;
  });
  expect(retained).toBe(true);
  await expect(page.locator('#agent-connection-status')).toContainText('恢复');
  await page.evaluate(() => (window as any).__recovery.tab.terminal.onSessionReady(true));
  await state(page);
  await expect(page.locator('#agent-send-btn')).toHaveClass(/is-stopping/);
  const replaced = await page.evaluate(() => {
    const { panel, tab } = (window as any).__recovery;
    tab.terminal.onSessionClosed(new CloseEvent('close', { code: 1006 }), true);
    tab.terminal.onSessionReady(false);
    return tab.agentPanel !== panel && panel.disposed;
  });
  expect(replaced).toBe(true);
});

test('恢复流式文本和任务 ID，不重发任务、不重复回复，并继续接收进度', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__recovery;
    panel.sendMessage('检查服务器');
    const requestId = sent.at(-1).requestId;
    panel.handleAgentFrame({ subType: 'stream_chunk', requestId, runId: 1, textId: 1, content: 'before' });
    panel.suspendConnection();
    panel.sendMessage('must not send while offline');
    panel.resumeConnection();
    panel.handleAgentFrame({ subType: 'state', syncId: 'stale-socket-query', state: {} });
  });
  await state(page, { text: 'before + during disconnect', textId: 1, textComplete: false });
  await expect(page.locator('#agent-messages')).toContainText('before + during disconnect');
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__recovery;
    const requestId = sent.find((frame: any) => frame.type === 'agent_start').requestId;
    panel.handleAgentFrame({ subType: 'stream_end', runId: 1, requestId, textId: 1, content: 'final result' });
    panel.handleAgentFrame({ subType: 'run_end', runId: 1, requestId, outcome: 'completed' });
    panel.resumeConnection();
  });
  await state(page, { phase: 'idle', text: 'final result', textId: 1, outcome: 'completed' });
  await expect(page.locator('.agent-md-content').filter({ hasText: 'final result' })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__recovery.sent.filter((f: any) => f.type === 'agent_start').length)).toBe(1);
});

test('恢复待确认操作不会重启自动批准，用户仍能明确批准原确认 ID', async ({ page }) => {
  await mount(page);
  await page.clock.install();
  await page.evaluate(() => {
    const { panel } = (window as any).__recovery;
    panel.setAgentMode('auto');
    panel.suspendConnection();
    panel.resumeConnection();
  });
  await state(page, { phase: 'waiting_confirmation', confirmation: {
    confirmationId: 'same-confirmation', command: 'restart example-service', reason: 'service restart',
  } });
  await expect(page.locator('#agent-messages')).toContainText('restart example-service');
  await page.clock.runFor(4_000);
  expect(await page.evaluate(() => (window as any).__recovery.sent.some((f: any) => f.type === 'agent_confirm'))).toBe(false);
  await page.locator('.agent-confirm-yes').click();
  expect(await page.evaluate(() => (window as any).__recovery.sent.at(-1))).toMatchObject({
    type: 'agent_confirm', confirmationId: 'same-confirmation', approved: true, command: 'restart example-service',
  });
});

test('同步等待期间暂停已有 Auto 确认，人工批准也不在未知状态下发送', async ({ page }) => {
  await mount(page);
  await page.clock.install();
  await page.evaluate(() => {
    const { panel } = (window as any).__recovery;
    panel.setAgentMode('auto');
    panel.handleAgentFrame({ subType: 'confirm_required', confirmationId: 'existing-confirmation',
      command: 'restart example-service', reason: 'restart' });
    panel.resumeConnection();
  });
  await page.clock.runFor(1_000);
  await page.locator('.agent-confirm-yes').click();
  await page.clock.runFor(3_000);
  expect(await page.evaluate(() => (window as any).__recovery.sent.some((f: any) =>
    f.type === 'agent_confirm' && f.approved))).toBe(false);
});

for (const outcome of ['completed', 'failed', 'stopped'] as const) {
  test(`任务在断线期间结束后恢复为空闲，不要求断开 SSH：${outcome}`, async ({ page }) => {
    await mount(page);
    await page.evaluate(() => {
      const { panel } = (window as any).__recovery;
      panel.sendMessage('original task');
      panel.suspendConnection();
      panel.resumeConnection();
    });
    await state(page, { phase: 'idle', text: `offline-${outcome}`, textId: 1, outcome });
    await expect(page.locator('#agent-messages')).toContainText(`offline-${outcome}`);
    await page.locator('#agent-input').fill('next task');
    await page.locator('#agent-send-btn').click();
    expect(await page.evaluate(() => (window as any).__recovery.sent
      .filter((f: any) => f.type === 'agent_start').map((f: any) => f.message)))
      .toEqual(['original task', 'next task']);
  });
}

test('连续三次重连替换流式快照，旧同步响应不能覆盖当前状态', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).__recovery.panel.sendMessage('original task'));
  for (let round = 1; round <= 3; round++) {
    await page.evaluate(() => {
      const { panel } = (window as any).__recovery;
      panel.suspendConnection(); panel.resumeConnection();
    });
    await state(page, { text: `progress-${round}`, textId: 1, textComplete: false });
    await expect(page.locator('#agent-messages')).toContainText(`progress-${round}`);
    await expect(page.locator('.agent-message.agent-response')).toHaveCount(1);
  }
  await page.evaluate(() => {
    const { panel, sent } = (window as any).__recovery;
    const oldQuery = sent.find((f: any) => f.type === 'agent_sync');
    panel.handleAgentFrame({ subType: 'state', syncId: oldQuery.syncId, state: {
      runId: 99, requestId: 'wrong-task', phase: 'idle', iteration: 0,
      text: 'STALE RESPONSE', textId: 1, textComplete: true, textTruncated: false,
    } });
  });
  await expect(page.locator('#agent-messages')).not.toContainText('STALE RESPONSE');
  await expect(page.locator('#agent-send-btn')).toHaveClass(/is-stopping/);
});

test('隐藏面板恢复确认不会暗中拒绝，重新打开后才能明确处理', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel } = (window as any).__recovery;
    panel.hide(); panel.suspendConnection(); panel.resumeConnection();
  });
  await state(page, { phase: 'waiting_confirmation', confirmation: {
    confirmationId: 'hidden-confirmation', command: 'restart example-service', reason: 'restart',
  } });
  expect(await page.evaluate(() => (window as any).__recovery.sent.some((f: any) => f.type === 'agent_confirm'))).toBe(false);
  await page.evaluate(() => (window as any).__recovery.panel.show());
  await expect(page.locator('.agent-confirm-yes')).toBeVisible();
  await page.locator('.agent-confirm-no').click();
  expect(await page.evaluate(() => (window as any).__recovery.sent.at(-1))).toMatchObject({
    type: 'agent_confirm', confirmationId: 'hidden-confirmation', approved: false,
  });
});

test('任务结束帧也会清理隐藏的恢复确认，不依赖 confirm_closed 必然送达', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { panel } = (window as any).__recovery;
    panel.hide(); panel.suspendConnection(); panel.resumeConnection();
  });
  await state(page, { phase: 'waiting_confirmation', confirmation: {
    confirmationId: 'finished-confirmation', command: 'restart example-service', reason: 'restart',
  } });
  await page.evaluate(() => {
    const { panel } = (window as any).__recovery;
    panel.handleAgentFrame({ subType: 'run_end', requestId: 'surviving-request', runId: 1, outcome: 'stopped' });
    panel.show();
  });
  await expect(page.locator('.agent-confirm')).toHaveCount(0);
  await expect(page.locator('#agent-input')).toBeEnabled();
});

test('换号销毁恢复中的面板，迟到的状态和进度不得复活旧任务', async ({ page }) => {
  await mount(page, true);
  const result = await page.evaluate(() => {
    const { panel, manager, sent } = (window as any).__recovery;
    panel.sendMessage('account A task'); panel.suspendConnection(); panel.resumeConnection();
    const query = sent.at(-1);
    const before = sent.length;
    manager.setUser(99);
    panel.handleAgentFrame({ subType: 'state', syncId: query.syncId, state: {
      runId: 1, requestId: 'account-A', phase: 'thinking', iteration: 1,
      text: 'PRIVATE OLD CONTENT', textId: 1, textComplete: false, textTruncated: false,
    } });
    panel.resumeConnection(); panel.sendMessage('must not send');
    return { disposed: panel.disposed, sentAfter: sent.length, before };
  });
  expect(result.disposed).toBe(true);
  expect(result.sentAfter).toBe(result.before);
  await expect(page.locator('body')).not.toContainText('PRIVATE OLD CONTENT');
});

test('busy 自愈同步；同步失败仍能停止当前任务，而不是必须断开 SSH', async ({ page }) => {
  await mount(page);
  await page.clock.install();
  await page.evaluate(() => {
    const { panel } = (window as any).__recovery;
    panel.sendMessage('new request');
    panel.handleAgentFrame({ subType: 'error', code: 'agent_busy', message: 'busy' });
  });
  expect(await page.evaluate(() => (window as any).__recovery.sent.at(-1).type)).toBe('agent_sync');
  await page.clock.runFor(5_100);
  await expect(page.locator('[data-agent-retry]')).toBeVisible();
  await page.locator('[data-agent-force-stop]').click();
  expect(await page.evaluate(() => (window as any).__recovery.sent.some((f: any) => f.type === 'agent_stop'))).toBe(true);
  await state(page, { phase: 'idle', outcome: 'stopped' });
  await page.locator('#agent-input').fill('next task');
  await expect(page.locator('#agent-send-btn')).toBeEnabled();
});
