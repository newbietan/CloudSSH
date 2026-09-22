import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enUS } from '../frontend/src/i18n/locales/en-US';
import { zhCN } from '../frontend/src/i18n/locales/zh-CN';
import { zhTW } from '../frontend/src/i18n/locales/zh-TW';

describe('Agent 面板控制与交互增强 (静态与词条校验)', () => {
  const panelSource = readFileSync(
    new URL('../frontend/src/agent/agent-panel.ts', import.meta.url),
    'utf8'
  );

  it('顶部操作栏包含新建会话按钮，并具有正确的多语言属性与图标', () => {
    expect(panelSource).toContain('id="agent-new-chat-btn"');
    expect(panelSource).toContain('data-i18n-title="agent.newChat"');
    expect(panelSource).toContain('add');
    expect(panelSource).toContain('handleNewChat');
  });

  it('发送按钮根据 isAgentRunning 状态动态切换发送与停止形态', () => {
    expect(panelSource).toContain("btn.classList.add('is-stopping')");
    expect(panelSource).toContain("btn.title = t('agent.stop')");
    expect(panelSource).toContain("btn.setAttribute('data-i18n-title', 'agent.stop')");
    expect(panelSource).toContain('material-symbols-outlined" style="font-size:18px;">stop<');
    expect(panelSource).toContain("btn.classList.remove('is-stopping')");
    expect(panelSource).toContain("btn.title = t('agent.send')");
  });

  it('用户消息气泡包含复制与回填编辑操作按钮', () => {
    expect(panelSource).toContain('agent-user-actions');
    expect(panelSource).toContain('agent-user-copy-btn');
    expect(panelSource).toContain('agent-user-edit-btn');
    expect(panelSource).toContain('data-i18n-title="agent.copyPrompt"');
    expect(panelSource).toContain('data-i18n-title="agent.editPrompt"');
    expect(panelSource).toContain('copyTextToClipboard(content)');
  });

  it('未完成任务时支持抢占式重发（supersede），向后端下发抢占标记', () => {
    expect(panelSource).toContain('const isSupersede = this.isAgentRunning');
    expect(panelSource).toContain("this.wsSend?.(JSON.stringify({ type: 'agent_stop' }))");
    expect(panelSource).toContain('supersede: isSupersede ? true : undefined');
    expect(panelSource).toContain('markLastActiveMessageAborted');
  });

  it('支持会话重置（agent_reset），清空草稿与消息状态', () => {
    expect(panelSource).toContain("this.wsSend?.(JSON.stringify({ type: 'agent_reset' }))");
    expect(panelSource).toContain('resetPanelState');
    expect(panelSource).toContain('this.clearSessionDraft()');
  });

  it('支持 Claude 风格气泡原地编辑重发与后续轮次清理', () => {
    expect(panelSource).toContain('enterInlineEditMode');
    expect(panelSource).toContain('agent-user-edit-bubble');
    expect(panelSource).toContain('agent-user-edit-textarea');
    expect(panelSource).toContain('agent-user-edit-cancel');
    expect(panelSource).toContain('agent-user-edit-save');
    expect(panelSource).toContain('submitInlineEdit');
    expect(panelSource).toContain('el.nextElementSibling.remove()');
    expect(panelSource).toContain('supersede: wasRunning ? true : undefined');
  });

  it('中止或响应时彻底移除流式半成品元素，仅保留停止响应', () => {
    expect(panelSource).toContain('this.streamingEl.remove()');
  });

  it('所有相关国际化词条在各语言包中均完整对齐', () => {
    const requiredKeys = [
      'agent.stop',
      'agent.stopped',
      'agent.abortedBadge',
      'agent.supersededNotice',
      'agent.editPrompt',
      'agent.copyPrompt',
      'agent.promptCopied',
      'agent.newChat',
      'agent.newChatConfirm',
      'agent.stopAndResend',
    ];

    for (const key of requiredKeys) {
      expect(zhCN[key as keyof typeof zhCN], `Missing zh-CN key: ${key}`).toBeDefined();
      expect(zhTW[key as keyof typeof zhTW], `Missing zh-TW key: ${key}`).toBeDefined();
      expect(enUS[key as keyof typeof enUS], `Missing en-US key: ${key}`).toBeDefined();
    }
  });
});

describe('页面切换与多会话抽屉自动收起', () => {
  const mainSource = readFileSync(new URL('../frontend/src/main.ts', import.meta.url), 'utf8');
  const tabManagerSource = readFileSync(
    new URL('../frontend/src/tab-manager.ts', import.meta.url),
    'utf8'
  );

  it('TabManager 提供 closeAllDrawers 方法收起所有标签的 Agent 与 SFTP 面板', () => {
    expect(tabManagerSource).toContain('closeAllDrawers(): void');
    expect(tabManagerSource).toContain('tab.agentPanel?.hide()');
    expect(tabManagerSource).toContain('tab.sftpPanel?.hide()');
    expect(tabManagerSource).toContain("document.body.classList.remove('agent-panel-open')");
  });

  it('切换到连接页面或退出终端视图时主动收起全部抽屉并重置分段条', () => {
    expect(mainSource).toContain('function closeAllDrawers(): void');
    expect(mainSource).toContain('tabManager?.closeAllDrawers()');
    expect(mainSource).toContain('snippetManager.close()');
    expect(mainSource).toContain('syncDrawerSegmentedControl()');

    // showConnectionPage / deactivateTerminalView 必须调用 closeAllDrawers
    const showConnectionPageCode = mainSource.slice(
      mainSource.indexOf('function showConnectionPage()'),
      mainSource.indexOf('function showOfflineUI()')
    );
    expect(showConnectionPageCode).toContain('closeAllDrawers()');

    const deactivateTerminalViewCode = mainSource.slice(
      mainSource.indexOf('function deactivateTerminalView()'),
      mainSource.indexOf('function showAuthSection()')
    );
    expect(deactivateTerminalViewCode).toContain('closeAllDrawers()');
  });

  it('新开标签页与活动标签切换时也确保抽屉状态重置与收起', () => {
    const showTerminalWithNewTabCode = mainSource.slice(
      mainSource.indexOf('function showTerminalWithNewTab('),
      mainSource.indexOf('function showTerminalFromServer(')
    );
    expect(showTerminalWithNewTabCode).toContain('closeAllDrawers()');

    expect(mainSource).toContain("document.addEventListener('cloudssh:active-terminal-change'");
  });
});
