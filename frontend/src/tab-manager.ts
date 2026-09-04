import { AgentPanel } from './agent/agent-panel';
import { copyTextToClipboard } from './clipboard';
import { maskIPAddress } from './host-display';
import { t } from './i18n';
import { getNetworkQuality } from './network-quality';
import { SFTPPanel } from './sftp-panel';
import { SSHTerminal, type TerminalSelectionAnchor } from './terminal';
import { notify } from './ui-feedback';

export type TabState = 'connecting' | 'connected' | 'disconnected';

export interface TabInfo {
  id: string;
  label: string;
  terminal: SSHTerminal;
  sftpPanel: SFTPPanel | null;
  agentPanel: AgentPanel | null;
  containerEl: HTMLElement;
  hostInfo?: { host: string; port: number; username?: string; serverId?: number };
  state: TabState;
  cfLatency?: number;
  cfColo?: string;
  wsLatency?: number;
  selectedText: string;
  selectionAnchor: TerminalSelectionAnchor | null;
}

/**
 * TabManager — 管理多个 SSH 会话标签页
 *
 * 每个标签页拥有独立的 SSHTerminal 实例和 SFTPPanel 实例。
 * 切换标签通过隐藏/显示对应的终端容器来实现，WebSocket 连接始终保持。
 */
export class TabManager {
  private tabs: Map<string, TabInfo> = new Map();
  private activeTabId: string | null = null;
  private tabBarEl: HTMLElement;
  private terminalAreaEl: HTMLElement;
  private tabCounter = 0;
  private _isLoggedIn: boolean = false;

  /** 标签右键菜单的 document click 监听器（关闭菜单时统一移除，防止累积） */
  private tabCtxCloseHandler: ((e: MouseEvent) => void) | null = null;

  /** 当所有标签都被关闭时触发，外部可以用它来回到连接页面 */
  private onAllTabsClosed?: () => void;

  /** 连接后检测到远端操作系统时触发（用于更新服务器列表图标） */
  private onOSDetected?: (serverId: number, os: string) => void;

  /** 标签数量变化时触发（用于同步返回终端按钮显隐等） */
  private onTabsChanged?: () => void;

  /** 克隆会话请求回调 */
  private onDuplicateTab?: (tab: TabInfo) => void;

  constructor(tabBarId: string, terminalAreaId: string) {
    this.tabBarEl = document.getElementById(tabBarId)!;
    this.terminalAreaEl = document.getElementById(terminalAreaId)!;
  }

  setLoggedIn(loggedIn: boolean): void {
    this._isLoggedIn = loggedIn;
    this.updateSelectionAction();
  }

  setAllTabsClosedHandler(handler: () => void): void {
    this.onAllTabsClosed = handler;
  }

  setOSDetectedHandler(handler: (serverId: number, os: string) => void): void {
    this.onOSDetected = handler;
  }

  setTabsChangedHandler(handler: () => void): void {
    this.onTabsChanged = handler;
  }

  setDuplicateTabHandler(handler: (tab: TabInfo) => void): void {
    this.onDuplicateTab = handler;
  }

  // ==================== 创建标签 ====================

  createTab(
    label: string,
    hostInfo?: { host: string; port: number; username?: string; serverId?: number }
  ): TabInfo {
    const id = `tab-${++this.tabCounter}-${Date.now()}`;

    // 创建终端容器（flex 布局，支持 AgentPanel 右侧分栏）
    const containerEl = document.createElement('div');
    containerEl.id = `terminal-container-${id}`;
    containerEl.className = 'absolute inset-0 overflow-hidden flex flex-row';
    containerEl.style.display = 'none';
    this.terminalAreaEl.appendChild(containerEl);

    // 内部终端包装器（flex-1 占满剩余空间）
    const terminalInner = document.createElement('div');
    terminalInner.id = `terminal-inner-${id}`;
    terminalInner.className = 'flex-1 min-w-0 relative overflow-hidden';
    containerEl.appendChild(terminalInner);

    // 创建 SSHTerminal 实例（挂在内部包装器上）
    const terminal = new SSHTerminal(terminalInner.id);

    // 设置会话关闭回调
    terminal.setSessionClosedHandler((_event, willReconnect) => {
      const tab = this.tabs.get(id);
      if (tab) {
        tab.state = willReconnect ? 'connecting' : 'disconnected';
        this.renderTabBar();
        if (this.activeTabId === id) {
          this.updateStatusBar(tab);
        }

        // 清理该标签的 SFTP 面板
        if (tab.sftpPanel) {
          tab.sftpPanel.dispose();
          tab.sftpPanel = null;
        }
        // 清理该标签的 Agent 面板
        if (tab.agentPanel) {
          tab.agentPanel.dispose();
          tab.agentPanel = null;
        }
        tab.selectedText = '';
        tab.selectionAnchor = null;
        this.updateSelectionAction(tab);
      }
    });

    // 设置 SSH 就绪回调：初始化 SFTP 面板 + Agent 面板
    terminal.setSessionReadyHandler(() => {
      const tab = this.tabs.get(id);
      if (tab) {
        tab.state = 'connected';
        this.renderTabBar();
        if (this.activeTabId === id) {
          this.updateStatusBar(tab);
        }

        // 初始化 SFTP 面板
        if (!tab.sftpPanel) {
          tab.sftpPanel = new SFTPPanel(() => tab.terminal.getSFTPWebSocketUrl());
          tab.sftpPanel.bindEvents();
        }
        tab.sftpPanel.handleSSHReady();

        // 初始化 Agent 面板（仅登录用户）
        if (this._isLoggedIn && !tab.agentPanel) {
          tab.agentPanel = new AgentPanel(tab.containerEl, true);
          tab.agentPanel.render();
          tab.agentPanel.setWebSocketSend((data: string) =>
            tab.terminal.sendWebSocketMessage(data)
          );
          tab.agentPanel.setTerminalFillHandler(
            () => ({
              label: this.getTerminalTargetLabel(tab),
              available: this.activeTabId === tab.id && tab.state === 'connected',
            }),
            (command: string) => {
              const activeTab = this.getActiveTab();
              if (activeTab?.id !== tab.id || tab.state !== 'connected') return false;
              return tab.terminal.fillInput(command);
            }
          );
          tab.terminal.setAgentFrameHandler((msg: any) => {
            tab.agentPanel?.handleAgentFrame(msg);
          });
          // AgentPanel 展开/收起时触发终端重新适配尺寸
          tab.agentPanel.setLayoutChangeHandler(() => tab.terminal.fit());
          this.updateSelectionAction(tab);
        }
      }
    });

    // 连接后检测到远端操作系统 → 通知外部更新服务器列表图标
    terminal.setOSDetectedHandler((serverId, os) => {
      this.onOSDetected?.(serverId, os);
    });

    // 设置延迟监测更新回调
    terminal.setLatencyUpdatedHandler((cfLatency, cfColo, wsLatency) => {
      const t = this.tabs.get(id);
      if (t) {
        t.cfLatency = cfLatency ?? undefined;
        t.cfColo = cfColo ?? undefined;
        t.wsLatency = wsLatency ?? undefined;
        if (this.activeTabId === id) {
          this.updateStatusBar(t);
        }
      }
    });

    const tab: TabInfo = {
      id,
      label,
      terminal,
      sftpPanel: null,
      agentPanel: null,
      containerEl,
      hostInfo,
      state: 'connecting',
      selectedText: '',
      selectionAnchor: null,
    };

    this.tabs.set(id, tab);
    terminal.setSelectionChangeHandler((selection, anchor) => {
      const currentTab = this.tabs.get(id);
      if (!currentTab) return;
      currentTab.selectedText = selection;
      currentTab.selectionAnchor = anchor;
      if (this.activeTabId === id) {
        this.updateSelectionAction(currentTab);
      }
    });
    this.switchTab(id);
    this.renderTabBar();
    this.tabsChanged();

    return tab;
  }

  // ==================== 切换标签 ====================

  switchTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (this.activeTabId === tabId) return;

    // 隐藏当前活跃标签的 SFTP 面板
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prevTab = this.tabs.get(this.activeTabId);
      if (prevTab) {
        prevTab.agentPanel?.rejectPendingConfirmation(false);
        prevTab.containerEl.style.display = 'none';
        prevTab.sftpPanel?.hide();
      }
    }

    // 显示目标标签
    tab.containerEl.style.display = 'flex';
    this.activeTabId = tabId;
    document.body.classList.toggle('agent-panel-open', tab.agentPanel?.isOpen ?? false);
    document.dispatchEvent(new Event('cloudssh:active-terminal-change'));

    // Mount 并 fit 终端
    tab.terminal.mount();

    // 更新状态栏
    this.updateStatusBar(tab);
    this.updateSelectionAction(tab);
    this.renderTabBar();
  }

  // ==================== 关闭标签 ====================

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // 清理资源
    if (tab.sftpPanel) {
      tab.sftpPanel.dispose();
      tab.sftpPanel = null;
    }
    if (tab.agentPanel) {
      tab.agentPanel.dispose();
      tab.agentPanel = null;
    }
    tab.terminal.dispose();
    tab.containerEl.remove();
    this.tabs.delete(tabId);

    // 如果关闭的是当前活跃标签，切换到其他标签
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        document.body.classList.remove('agent-panel-open');
        this.onAllTabsClosed?.();
      }
    }

    this.renderTabBar();
    this.updateSelectionAction();
    this.tabsChanged();
  }

  closeAllTabs(): void {
    const tabIds = Array.from(this.tabs.keys());
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId);
      if (!tab) continue;

      if (tab.sftpPanel) {
        tab.sftpPanel.dispose();
        tab.sftpPanel = null;
      }
      if (tab.agentPanel) {
        tab.agentPanel.dispose();
        tab.agentPanel = null;
      }
      tab.terminal.dispose();
      tab.containerEl.remove();
    }

    this.tabs.clear();
    this.activeTabId = null;
    document.body.classList.remove('agent-panel-open');
    this.renderTabBar();
    this.updateSelectionAction();
    this.onAllTabsClosed?.();
    this.tabsChanged();
  }

  // ==================== 获取当前活跃标签 ====================

  getActiveTab(): TabInfo | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId) || null;
  }

  getTabCount(): number {
    return this.tabs.size;
  }

  hasAnyTab(): boolean {
    return this.tabs.size > 0;
  }

  private getTerminalTargetLabel(tab: TabInfo): string {
    if (!tab.hostInfo) return tab.label;
    const userPrefix = tab.hostInfo.username ? `${tab.hostInfo.username}@` : '';
    return `${tab.label} · ${userPrefix}${tab.hostInfo.host}:${tab.hostInfo.port}`;
  }

  refreshTranslations(): void {
    this.renderTabBar();
    const activeTab = this.getActiveTab();
    if (activeTab) this.updateStatusBar(activeTab);
  }

  // ==================== 关闭当前活跃标签 ====================

  closeActiveTab(): void {
    if (this.activeTabId) {
      this.closeTab(this.activeTabId);
    }
  }

  // ==================== 断开当前标签的连接 ====================

  disconnectActiveTab(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    if (tab.sftpPanel) {
      tab.sftpPanel.hide();
    }
    tab.agentPanel?.rejectPendingConfirmation(false);
    tab.agentPanel?.clearTerminalSelectionContext();
    tab.terminal.disconnect();
    tab.state = 'disconnected';
    tab.selectedText = '';
    tab.selectionAnchor = null;
    this.updateSelectionAction(tab);
    this.renderTabBar();
  }

  /** 将当前终端选区附加到 Agent 输入区，等待用户补充问题后发送。 */
  askAIAboutActiveSelection(): boolean {
    const tab = this.getActiveTab();
    const selection = tab?.selectedText || '';
    if (!tab?.agentPanel || !selection.trim()) return false;

    const attached = tab.agentPanel.attachTerminalSelection(
      selection,
      this.getTerminalTargetLabel(tab)
    );
    if (attached) {
      tab.terminal.clearSelection();
    }
    return attached;
  }

  // ==================== 渲染标签栏 ====================

  renderTabBar(): void {
    // 保留 new-tab-btn，清除其他标签按钮
    const newTabBtn = this.tabBarEl.querySelector('#new-tab-btn');
    this.tabBarEl.replaceChildren();

    for (const tab of this.tabs.values()) {
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item${tab.id === this.activeTabId ? ' active' : ''}${tab.state === 'disconnected' ? ' disconnected' : ''}`;
      tabEl.dataset.tabId = tab.id;

      // 状态指示点
      const dot = document.createElement('span');
      dot.className = `tab-dot ${this.tabDotClass(tab.state)}`;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.label;
      label.title = `${t('terminal.doubleClickToRename')}: ${tab.label}`;

      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.startRenameTab(tab, label);
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.title = t('terminal.closeTab');
      closeBtn.appendChild(this.createIcon('close', '14px'));

      tabEl.append(dot, label, closeBtn);

      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showTabContextMenu(tab, e.clientX, e.clientY);
      });

      // 点击标签切换
      tabEl.addEventListener('click', (e) => {
        // 如果点击的是关闭按钮，不触发切换
        if ((e.target as HTMLElement).closest('.tab-close')) return;
        this.switchTab(tab.id);
      });

      // 关闭按钮
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });

      this.tabBarEl.appendChild(tabEl);
    }

    // 追加 new-tab-btn
    if (newTabBtn) {
      this.tabBarEl.appendChild(newTabBtn);
    } else {
      const btn = document.createElement('button');
      btn.id = 'new-tab-btn';
      btn.className = 'tab-new-btn';
      btn.title = t('terminal.newConnection');
      btn.appendChild(this.createIcon('add', '16px'));
      this.tabBarEl.appendChild(btn);
    }
  }

  private tabDotClass(state: TabState): string {
    if (state === 'connected') return 'tab-dot-connected';
    if (state === 'connecting') return 'tab-dot-connecting';
    return 'tab-dot-disconnected';
  }

  // ==================== 标签重命名与右键菜单 ====================

  renameTab(tabId: string, newLabel: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const trimmed = newLabel.trim();
    if (trimmed) tab.label = trimmed;
    // 空值/未变更时同样重新渲染，恢复原标签显示（避免重命名输入框卡在标签栏）
    this.renderTabBar();
    if (this.activeTabId === tabId) {
      this.updateStatusBar(tab);
    }
  }

  private startRenameTab(tab: TabInfo, labelEl: HTMLElement): void {
    const currentName = tab.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className =
      'tab-rename-input terminal-input px-1 py-0 text-xs w-28 bg-surface border border-outline-variant';
    input.value = currentName;
    input.maxLength = 40;

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      this.renameTab(tab.id, input.value);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        this.renderTabBar();
      }
    });
    input.addEventListener('blur', () => commit());
    input.addEventListener('click', (e) => e.stopPropagation());

    labelEl.replaceWith(input);
    input.focus();
    input.select();
  }

  closeOtherTabs(keepTabId: string): void {
    for (const tab of Array.from(this.tabs.values())) {
      if (tab.id !== keepTabId) {
        this.closeTab(tab.id);
      }
    }
  }

  private showTabContextMenu(tab: TabInfo, x: number, y: number): void {
    this.hideTabContextMenu();

    const menu = document.createElement('div');
    menu.id = 'tab-context-menu';
    menu.className =
      'fixed z-[100] cyber-box py-1 shadow-2xl text-xs bg-surface border border-outline-variant text-on-surface';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const items = [
      {
        label: t('terminal.renameTab'),
        icon: 'edit',
        action: () => {
          const tabEl = this.tabBarEl.querySelector(`[data-tab-id="${tab.id}"]`);
          const labelEl = tabEl?.querySelector('.tab-label') as HTMLElement | null;
          if (labelEl) this.startRenameTab(tab, labelEl);
        },
      },
      {
        label: t('terminal.duplicateTab'),
        icon: 'content_copy',
        action: () => {
          this.onDuplicateTab?.(tab);
        },
      },
      {
        label: t('terminal.closeOtherTabs'),
        icon: 'close_fullscreen',
        action: () => {
          this.closeOtherTabs(tab.id);
        },
      },
      {
        label: t('terminal.closeTab'),
        icon: 'close',
        action: () => {
          this.closeTab(tab.id);
        },
        className: 'text-error',
      },
    ];

    for (const item of items) {
      const itemEl = document.createElement('div');
      itemEl.className = `flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant cursor-pointer ${item.className || ''}`;
      itemEl.appendChild(this.createIcon(item.icon, '14px'));
      itemEl.appendChild(document.createTextNode(item.label));
      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hideTabContextMenu();
        item.action();
      });
      menu.appendChild(itemEl);
    }

    document.body.appendChild(menu);

    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.hideTabContextMenu();
      }
    };
    // capture 阶段挂载，确保菜单项等内部 stopPropagation 不影响包含性判断；
    // setTimeout(0) 避开部分平台 contextmenu 后紧跟的合成 click
    this.tabCtxCloseHandler = closeHandler;
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }

  private hideTabContextMenu(): void {
    // 统一移除 document 监听器：菜单项点击（stopPropagation）与外部点击均不残留
    if (this.tabCtxCloseHandler) {
      document.removeEventListener('click', this.tabCtxCloseHandler, true);
      this.tabCtxCloseHandler = null;
    }
    const existing = document.getElementById('tab-context-menu');
    existing?.remove();
  }

  private createIcon(name: string, size: string): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.style.fontSize = size;
    icon.textContent = name;
    return icon;
  }

  private setStatusIndicator(el: HTMLElement | null, dotClass: string, text: string): void {
    if (!el) return;
    const dot = document.createElement('span');
    dot.className = `${dotClass} inline-block`;
    el.replaceChildren(dot, document.createTextNode(text));
  }

  // ==================== 状态栏同步 ====================

  private updateStatusBar(tab: TabInfo): void {
    const termHost = document.getElementById('term-host');
    const termUser = document.getElementById('term-user');
    const termPort = document.getElementById('term-port');
    const termStatus = document.getElementById('term-status');
    const statusText = document.getElementById('status-text');

    if (tab.hostInfo) {
      if (termHost) {
        const masked = maskIPAddress(tab.hostInfo.host);
        if (masked) {
          const copyIPLabel = t('terminal.clickToCopyIP');
          const badge = document.createElement('button');
          badge.type = 'button';
          badge.className = 'host-ip-badge';
          badge.title = copyIPLabel;
          badge.setAttribute('aria-label', copyIPLabel);
          badge.textContent = masked;
          termHost.replaceChildren(document.createTextNode(t('terminal.hostLabel')), badge);
          badge.addEventListener('click', async () => {
            const ok = await copyTextToClipboard(tab.hostInfo!.host);
            if (ok) {
              badge.classList.add('host-ip-copied');
              setTimeout(() => badge.classList.remove('host-ip-copied'), 800);
              notify(t('terminal.ipCopied'), { variant: 'success', duration: 1500 });
            } else {
              notify(t('terminal.ipCopyFailed'), { variant: 'danger' });
            }
          });
        } else {
          termHost.textContent = t('terminal.host', { value: tab.hostInfo.host });
        }
      }
      if (termUser)
        termUser.textContent = tab.hostInfo.username
          ? t('terminal.user', { value: tab.hostInfo.username })
          : '';
      if (termPort) termPort.textContent = t('terminal.port', { value: tab.hostInfo.port });
    } else {
      if (termHost) termHost.textContent = t('terminal.server', { value: tab.label });
      if (termUser) termUser.textContent = '';
      if (termPort) termPort.textContent = '';
    }

    if (tab.state === 'connected') {
      this.setStatusIndicator(termStatus, 'w-2 h-2 bg-primary-container', t('terminal.connected'));
      this.setStatusIndicator(
        statusText,
        'w-2 h-2 bg-[var(--accent)] animate-pulse',
        t('auth.statusOnline')
      );
    } else if (tab.state === 'connecting') {
      this.setStatusIndicator(
        termStatus,
        'w-2 h-2 bg-primary-container animate-pulse',
        t('terminal.connecting')
      );
    } else {
      this.setStatusIndicator(termStatus, 'w-2 h-2 bg-[var(--error)]', t('terminal.disconnected'));
      this.setStatusIndicator(statusText, 'w-2 h-2 bg-surface-dot', t('auth.statusOffline'));
    }

    // 更新状态栏显示延迟信息
    const termInfo = document.getElementById('term-info');
    if (termInfo) {
      if (tab.state === 'connected') {
        const latencyItems: { label: string; quality: string }[] = [];
        if (tab.cfLatency !== undefined) {
          latencyItems.push({
            label: `CF-${tab.cfColo || 'UNK'}: ${tab.cfLatency}ms`,
            quality: getNetworkQuality(tab.cfLatency, 'cf'),
          });
        }
        if (tab.wsLatency !== undefined) {
          latencyItems.push({
            label: `RTT: ${tab.wsLatency}ms`,
            quality: getNetworkQuality(tab.wsLatency, 'ws'),
          });
        }
        if (latencyItems.length > 0) {
          const fragment = document.createDocumentFragment();
          fragment.appendChild(document.createTextNode('⚡ '));
          for (const [index, item] of latencyItems.entries()) {
            if (index > 0) {
              const separator = document.createElement('span');
              separator.className = 'network-latency-separator';
              separator.setAttribute('aria-hidden', 'true');
              separator.textContent = '|';
              fragment.appendChild(separator);
            }
            const itemEl = document.createElement('span');
            itemEl.className = 'network-latency-item';
            const dot = document.createElement('span');
            dot.className = `network-quality-dot network-quality-${item.quality}`;
            dot.setAttribute('aria-hidden', 'true');
            itemEl.append(dot, document.createTextNode(item.label));
            fragment.appendChild(itemEl);
          }
          termInfo.replaceChildren(fragment);
        } else {
          termInfo.textContent = '';
        }
      } else {
        termInfo.textContent = '';
      }
    }
  }

  private updateSelectionAction(tab: TabInfo | null = this.getActiveTab()): void {
    const button = document.getElementById('ask-ai-selection-btn');
    if (!button) return;
    const visible = !!(
      this._isLoggedIn &&
      tab &&
      tab.id === this.activeTabId &&
      tab.state === 'connected' &&
      tab.agentPanel &&
      tab.selectedText.trim() &&
      tab.selectionAnchor
    );
    button.classList.toggle('hidden', !visible);
    if (!visible || !tab?.selectionAnchor) return;

    const gap = 12;
    const viewportPadding = 8;
    const { clientX, clientY } = tab.selectionAnchor;
    const terminalBounds = tab.containerEl.getBoundingClientRect();
    let left = clientX + gap;
    let top = clientY + gap;

    if (left + button.offsetWidth > terminalBounds.right - viewportPadding) {
      left = clientX - button.offsetWidth - gap;
    }
    if (top + button.offsetHeight > terminalBounds.bottom - viewportPadding) {
      top = clientY - button.offsetHeight - gap;
    }

    button.style.left = `${Math.max(terminalBounds.left + viewportPadding, left)}px`;
    button.style.top = `${Math.max(terminalBounds.top + viewportPadding, top)}px`;
  }

  private tabsChanged(): void {
    this.onTabsChanged?.();
  }
}
