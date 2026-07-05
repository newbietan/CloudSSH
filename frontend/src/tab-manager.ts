import { SSHTerminal, SSHConnectionConfig, THEMES } from './terminal';
import { SFTPPanel } from './sftp-panel';

export type TabState = 'connecting' | 'connected' | 'disconnected';

export interface TabInfo {
  id: string;
  label: string;
  terminal: SSHTerminal;
  sftpPanel: SFTPPanel | null;
  containerEl: HTMLElement;
  hostInfo?: { host: string; port: number; username?: string };
  state: TabState;
  cfLatency?: number;
  cfColo?: string;
  wsLatency?: number;
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

  /** 当所有标签都被关闭时触发，外部可以用它来回到连接页面 */
  private onAllTabsClosed?: () => void;

  constructor(tabBarId: string, terminalAreaId: string) {
    this.tabBarEl = document.getElementById(tabBarId)!;
    this.terminalAreaEl = document.getElementById(terminalAreaId)!;
  }

  setAllTabsClosedHandler(handler: () => void): void {
    this.onAllTabsClosed = handler;
  }

  // ==================== 创建标签 ====================

  createTab(label: string, hostInfo?: { host: string; port: number; username?: string }): TabInfo {
    const id = `tab-${++this.tabCounter}-${Date.now()}`;

    // 创建终端容器
    const containerEl = document.createElement('div');
    containerEl.id = `terminal-container-${id}`;
    containerEl.className = 'absolute inset-0 overflow-hidden';
    containerEl.style.display = 'none';
    this.terminalAreaEl.appendChild(containerEl);

    // 创建 SSHTerminal 实例
    const terminal = new SSHTerminal(containerEl.id);

    // 设置会话关闭回调
    terminal.setSessionClosedHandler(() => {
      const tab = this.tabs.get(id);
      if (tab) {
        tab.state = 'disconnected';
        this.renderTabBar();
        if (this.activeTabId === id) {
          this.updateStatusBar(tab);
        }

        // 清理该标签的 SFTP 面板
        if (tab.sftpPanel) {
          tab.sftpPanel.dispose();
          tab.sftpPanel = null;
        }
      }
    });

    // 设置 SSH 就绪回调：初始化 SFTP 面板
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
      }
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
      containerEl,
      hostInfo,
      state: 'connecting',
    };

    this.tabs.set(id, tab);
    this.switchTab(id);
    this.renderTabBar();

    return tab;
  }

  // ==================== 切换标签 ====================

  switchTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // 隐藏当前活跃标签的 SFTP 面板
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prevTab = this.tabs.get(this.activeTabId);
      if (prevTab) {
        prevTab.containerEl.style.display = 'none';
        prevTab.sftpPanel?.hide();
      }
    }

    // 显示目标标签
    tab.containerEl.style.display = 'flex';
    this.activeTabId = tabId;

    // Mount 并 fit 终端
    tab.terminal.mount();

    // 更新状态栏
    this.updateStatusBar(tab);
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
        this.onAllTabsClosed?.();
      }
    }

    this.renderTabBar();
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
    tab.terminal.disconnect();
    tab.state = 'disconnected';
    this.renderTabBar();
  }

  // ==================== 渲染标签栏 ====================

  renderTabBar(): void {
    // 保留 new-tab-btn，清除其他标签按钮
    const newTabBtn = this.tabBarEl.querySelector('#new-tab-btn');
    this.tabBarEl.innerHTML = '';

    this.tabs.forEach((tab) => {
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item${tab.id === this.activeTabId ? ' active' : ''}${tab.state === 'disconnected' ? ' disconnected' : ''}`;
      tabEl.dataset.tabId = tab.id;

      // 状态指示点
      const dotClass = tab.state === 'connected' ? 'tab-dot-connected'
                      : tab.state === 'connecting' ? 'tab-dot-connecting'
                      : 'tab-dot-disconnected';

      tabEl.innerHTML = `
        <span class="tab-dot ${dotClass}"></span>
        <span class="tab-label">${this.escapeHtml(tab.label)}</span>
        <button class="tab-close" title="Close">
          <span class="material-symbols-outlined" style="font-size:14px;">close</span>
        </button>
      `;

      // 点击标签切换
      tabEl.addEventListener('click', (e) => {
        // 如果点击的是关闭按钮，不触发切换
        if ((e.target as HTMLElement).closest('.tab-close')) return;
        this.switchTab(tab.id);
      });

      // 关闭按钮
      tabEl.querySelector('.tab-close')!.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });

      this.tabBarEl.appendChild(tabEl);
    });

    // 追加 new-tab-btn
    if (newTabBtn) {
      this.tabBarEl.appendChild(newTabBtn);
    } else {
      const btn = document.createElement('button');
      btn.id = 'new-tab-btn';
      btn.className = 'tab-new-btn';
      btn.title = 'New Connection';
      btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">add</span>';
      this.tabBarEl.appendChild(btn);
    }
  }

  // ==================== 状态栏同步 ====================

  private updateStatusBar(tab: TabInfo): void {
    const termHost = document.getElementById('term-host');
    const termUser = document.getElementById('term-user');
    const termPort = document.getElementById('term-port');
    const termStatus = document.getElementById('term-status');
    const statusText = document.getElementById('status-text');

    if (tab.hostInfo) {
      if (termHost) termHost.textContent = `Host: ${tab.hostInfo.host}`;
      if (termUser) termUser.textContent = tab.hostInfo.username ? `User: ${tab.hostInfo.username}` : '';
      if (termPort) termPort.textContent = `Port: ${tab.hostInfo.port}`;
    } else {
      if (termHost) termHost.textContent = `Server: ${tab.label}`;
      if (termUser) termUser.textContent = '';
      if (termPort) termPort.textContent = '';
    }

    if (tab.state === 'connected') {
      if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-primary-container"></div> Connected';
      if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-[var(--accent)] inline-block animate-pulse"></span> STATUS: ONLINE';
    } else if (tab.state === 'connecting') {
      if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-primary-container animate-pulse"></div> Connecting';
    } else {
      if (termStatus) termStatus.innerHTML = '<div class="w-2 h-2 bg-[var(--error)]"></div> Disconnected';
      if (statusText) statusText.innerHTML = '<span class="w-2 h-2 bg-surface-dot inline-block"></span> STATUS: OFFLINE';
    }

    // 更新状态栏显示延迟信息
    const termInfo = document.getElementById('term-info');
    if (termInfo) {
      if (tab.state === 'connected') {
        const cfText = tab.cfLatency !== undefined ? `CF-${tab.cfColo || 'UNK'}: ${tab.cfLatency}ms` : '';
        const wsText = tab.wsLatency !== undefined ? ` | RTT: ${tab.wsLatency}ms` : '';
        if (cfText || wsText) {
          termInfo.textContent = `⚡ ${cfText}${wsText}`;
        } else {
          termInfo.textContent = '';
        }
      } else {
        termInfo.textContent = '';
      }
    }
  }

  // ==================== 工具函数 ====================

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
