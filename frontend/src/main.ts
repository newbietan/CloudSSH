import { AIConfigPanel } from './ai-config';
import { openAdminHashGeneratorDialog } from './admin-hash-generator';
import { ConnectionForm } from './auth-form';
import { initI18n, onLocaleChange, t } from './i18n';
import { MobileTerminalController } from './mobile-terminal';
import { ServerList } from './server-list';
import {
  type ClaimedShare,
  renderShareEnded,
  renderShareLanding,
  takeShareTokenFromLocation,
} from './share-session';
import { SnippetManager } from './snippet-manager';
import { TabManager } from './tab-manager';
import type { SSHHostInfo, SSHTerminal } from './terminal';
import {
  applyBuiltInTheme,
  applyImportedTheme,
  type BuiltInThemeName,
  isBuiltInTheme,
  normalizeImportedTheme,
  THEME_MAX_BYTES,
} from './theme';
import { LiquidSegmentedThemeControl } from './theme-segmented';
import { LiquidSegmentedDrawerControl } from './drawer-segmented';
import { notify } from './ui-feedback';

// ==================== 全局状态 ====================

let tabManager: TabManager | null = null;
let connectionForm: ConnectionForm | null = null;
let serverList: ServerList | null = null;
let isLoggedIn = false;
let sharedSessionMode = false;
const mobileTerminalController = new MobileTerminalController(
  () => tabManager?.getActiveTab()?.terminal ?? null
);
const snippetManager = new SnippetManager({
  getTerminal: () => tabManager?.getActiveTab()?.terminal ?? null,
  isAuthenticated: () => isLoggedIn && !sharedSessionMode,
  onStateChange: () => syncDrawerSegmentedControl(),
});

function setUserSpaceMenuOpen(open: boolean): void {
  document.getElementById('user-space-header-actions')?.classList.toggle('is-open', open);
  document.getElementById('user-space-more-btn')?.setAttribute('aria-expanded', String(open));
}

function initUserSpaceMobileMenu(): void {
  const button = document.getElementById('user-space-more-btn');
  const menu = document.getElementById('user-space-header-actions');
  if (!button || !menu) return;

  button.addEventListener('click', () => {
    setUserSpaceMenuOpen(!menu.classList.contains('is-open'));
  });
  menu.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) setUserSpaceMenuOpen(false);
  });
  menu.addEventListener('change', () => setUserSpaceMenuOpen(false));
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Node | null;
      if (target && (button.contains(target) || menu.contains(target))) return;
      setUserSpaceMenuOpen(false);
    },
    true
  );
}

function initServerPaginationBreakpoints(): void {
  const queries = [
    window.matchMedia('(max-width: 767px)'),
    window.matchMedia('(max-width: 1180px) and (pointer: coarse)'),
  ];
  for (const query of queries) {
    query.addEventListener('change', () => serverList?.refreshPageSize());
  }
}

/** 获取或初始化 TabManager 单例 */
function getTabManager(): TabManager {
  if (!tabManager) {
    tabManager = new TabManager('tab-bar', 'terminal-area');
    tabManager.setAllTabsClosedHandler(() => {
      showOfflineUI();
    });
    tabManager.setLoggedIn(isLoggedIn);
    // 连接后检测到操作系统 → 即时更新服务器列表卡片图标
    tabManager.setOSDetectedHandler((serverId, os) => {
      serverList?.updateServerOS(serverId, os);
    });
    // 标签数量变化 → 同步“返回终端”按钮显隐
    tabManager.setTabsChangedHandler(() => {
      syncConnectionBackButtons();
    });
    // 右键标签页克隆会话
    tabManager.setDuplicateTabHandler(async (tab) => {
      const serverId = tab.hostInfo?.serverId;
      if (!serverId) {
        notify(t('terminal.duplicateAnonymousUnsupported'), { variant: 'warning' });
        return;
      }
      try {
        const ws = await requestSavedServerWebSocket(serverId);
        const { terminal } = showTerminalWithNewTab(tab.label, tab.hostInfo);
        terminal.mount();
        const reconnectFactory = () => requestSavedServerWebSocket(serverId);
        terminal.connectWithWebSocket(ws, tab.hostInfo, { reconnectFactory });
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), { variant: 'danger' });
      }
    });

    // 绑定 new-tab-btn
    bindNewTabButton();
  }
  return tabManager;
}

function bindNewTabButton(): void {
  // 使用事件委托，因为 TabManager.renderTabBar() 会重建按钮
  document.getElementById('tab-bar')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('#new-tab-btn');
    if (!btn) return;
    // 点击 + 按钮：回到连接页面以创建新连接
    showConnectionPage();
  });
}

function syncConnectionBackButtons(): void {
  const hasTabs = tabManager?.hasAnyTab() ?? false;
  document.getElementById('back-to-terminal-btn')?.classList.toggle('hidden', !hasTabs);
  document.getElementById('back-to-terminal-from-auth-btn')?.classList.toggle('hidden', !hasTabs);
}

function activateTerminalView(): void {
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('server-modal')?.classList.add('hidden');
  document.getElementById('server-modal')?.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.remove('hidden');
  document.getElementById('terminal-section')!.classList.add('flex');
  document.body.classList.add('terminal-active');
  requestAnimationFrame(() => {
    terminalDrawerControl?.refresh();
  });
}

function showTerminalSection(): void {
  if (!tabManager || !tabManager.hasAnyTab()) return;
  tabManager.getActiveTab()?.agentPanel?.rejectPendingConfirmation(false);
  activateTerminalView();
  tabManager.getActiveTab()?.terminal.fit();
}

function bindBackToTerminalButtons(): void {
  document.getElementById('back-to-terminal-btn')?.addEventListener('click', () => {
    showTerminalSection();
  });
  document.getElementById('back-to-terminal-from-auth-btn')?.addEventListener('click', () => {
    showTerminalSection();
  });
  // 支持 Esc 快速返回已有的终端会话
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const terminalHidden =
      document.getElementById('terminal-section')?.classList.contains('hidden') ?? true;
    if (!terminalHidden) return;
    if (!tabManager?.hasAnyTab()) return;
    const activeModal = document.getElementById('server-modal');
    // 若服务器编辑弹窗打开，优先关闭弹窗而非返回终端
    if (activeModal && !activeModal.classList.contains('hidden')) return;
    event.preventDefault();
    showTerminalSection();
  });
}

// ==================== 独立终端标签页模式 ====================

function isTerminalTab(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('wsUrl');
}

function validateWsUrl(wsUrl: string): boolean {
  try {
    const url = new URL(wsUrl);
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return false;
    return (
      url.origin === window.location.origin ||
      url.origin === window.location.origin.replace(/^http/, 'ws')
    );
  } catch {
    return false;
  }
}

function initTerminalTab(): void {
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get('wsUrl')!;
  const serverName = params.get('name') || 'Server';
  const host = params.get('host') || '';
  const port = parseInt(params.get('port') || '0', 10) || 0;

  if (!validateWsUrl(wsUrl)) {
    const errorDiv = document.createElement('div');
    errorDiv.style.color = 'var(--error)';
    errorDiv.style.padding = '2em';
    errorDiv.style.fontFamily = 'monospace';
    errorDiv.textContent = t('terminal.invalidUrl');
    document.body.replaceChildren(errorDiv);
    return;
  }

  // 隐藏所有非终端元素
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.remove('hidden');
  document.getElementById('terminal-section')!.classList.add('flex');
  document.body.classList.add('terminal-active');

  // 匿名模式直连：确保 AI Agent 入口隐藏
  document.getElementById('agent-toggle-btn')?.classList.add('hidden');
  document.getElementById('mobile-agent-btn')?.classList.add('hidden');

  // 隐藏标签栏（URL 直连模式只有一个标签，不需要标签栏）
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.display = 'none';

  const tm = getTabManager();
  const tab = tm.createTab(serverName, host && port ? { host, port } : undefined);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const hostInfo = host && port ? { host, port } : undefined;
  tab.terminal.connectWithWebSocket(ws, hostInfo);
}

// ==================== 页面切换 ====================

function deactivateTerminalView(): void {
  closeAllDrawers();
  mobileTerminalController.leaveTerminal();
  document.getElementById('terminal-section')!.classList.add('hidden');
  document.getElementById('terminal-section')!.classList.remove('flex');
  document.body.classList.remove('terminal-active');
}

function showAuthSection(): void {
  deactivateTerminalView();
  document.getElementById('auth-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('server-modal')!.classList.add('hidden');
  document.getElementById('server-modal')!.classList.remove('flex');

  // 匿名模式/退出登录：隐藏 AI Agent 按钮（桌面分段条与移动端菜单）
  document.getElementById('agent-toggle-btn')?.classList.add('hidden');
  document.getElementById('mobile-agent-btn')?.classList.add('hidden');

  if (!connectionForm) {
    connectionForm = new ConnectionForm({
      getTabManager,
    });
  }
  syncConnectionBackButtons();
}

function showUserSpace(user: {
  id: number;
  github_id: number;
  username: string;
  avatar_url: string | null;
}): void {
  deactivateTerminalView();
  isLoggedIn = true;
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('flex');
  requestAnimationFrame(() => {
    userThemeSegmentedControl?.refresh();
  });

  // Show agent toggle button for logged-in users
  document.getElementById('agent-toggle-btn')?.classList.remove('hidden');
  document.getElementById('mobile-agent-btn')?.classList.remove('hidden');

  serverList = new ServerList(
    user,
    // onLogout 回调
    () => {
      isLoggedIn = false;
      serverList = null;
      if (tabManager) {
        tabManager.closeAllTabs();
      }
      showAuthSection();
    },
    // onConnect 回调 — 在当前页面创建新标签
    (wsUrl: string, serverName: string, hostInfo?: SSHHostInfo) => {
      showTerminalFromServer(wsUrl, serverName, hostInfo);
    }
  );
}

/** 显示连接页面（匿名 → auth-form，登录 → 服务器列表） */
function showConnectionPage(): void {
  closeAllDrawers();

  // 如果还有活跃标签，不需要隐藏终端区域；只需要覆盖显示连接页面
  // 但为了简单起见，我们先切回对应的入口页面
  if (isLoggedIn) {
    deactivateTerminalView();
    document.getElementById('user-space-section')!.classList.remove('hidden');
    document.getElementById('user-space-section')!.classList.add('flex');
    requestAnimationFrame(() => {
      userThemeSegmentedControl?.refresh();
    });
  } else {
    showAuthSection();
  }
  syncConnectionBackButtons();
}

function showOfflineUI(): void {
  if (sharedSessionMode) {
    deactivateTerminalView();
    renderShareEnded();
    return;
  }
  if (isTerminalTab()) {
    mobileTerminalController.leaveTerminal();
    window.close();
    return;
  }

  // 如果还有其他标签，不回到连接页
  if (tabManager && tabManager.hasAnyTab()) {
    return;
  }

  deactivateTerminalView();

  if (isLoggedIn) {
    document.getElementById('user-space-section')?.classList.remove('hidden');
    document.getElementById('user-space-section')?.classList.add('flex');
  } else {
    showAuthSection();
  }

  const statusText = document.getElementById('status-text');
  if (statusText) {
    const dot = document.createElement('span');
    dot.className = 'w-2 h-2 bg-surface-dot inline-block';
    statusText.replaceChildren(dot, document.createTextNode(t('auth.statusOffline')));
  }
}

/** 在终端页面创建新标签并显示终端视图 */
function showTerminalWithNewTab(
  displayLabel: string,
  hostInfo?: SSHHostInfo
): { tab: ReturnType<TabManager['createTab']>; terminal: SSHTerminal } {
  closeAllDrawers();
  activateTerminalView();

  const tm = getTabManager();
  const tab = tm.createTab(displayLabel, hostInfo);

  return { tab, terminal: tab.terminal };
}

function showTerminalFromServer(wsUrl: string, serverName: string, hostInfo?: SSHHostInfo): void {
  if (!validateWsUrl(wsUrl)) {
    notify(t('server.invalidWs'), {
      title: t('server.connectFailed'),
      variant: 'danger',
    });
    return;
  }

  const { terminal } = showTerminalWithNewTab(serverName, hostInfo);

  terminal.mount();

  // 通过 wsUrl（含 one-time-token）建立连接
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const serverId = hostInfo?.serverId;
  const reconnectFactory = serverId ? () => requestSavedServerWebSocket(serverId) : undefined;
  terminal.connectWithWebSocket(ws, hostInfo, { reconnectFactory });
}

function showSharedTerminal(claim: ClaimedShare): void {
  if (!validateWsUrl(claim.wsUrl)) {
    renderShareEnded();
    return;
  }
  sharedSessionMode = true;
  isLoggedIn = false;
  document.getElementById('agent-toggle-btn')?.classList.add('hidden');
  document.getElementById('mobile-agent-btn')?.classList.add('hidden');
  document.getElementById('snippet-toggle-btn')?.classList.add('hidden');
  document.getElementById('mobile-snippets-btn')?.classList.add('hidden');
  const tabBar = document.getElementById('tab-bar');
  if (tabBar) tabBar.style.display = 'none';
  const { terminal } = showTerminalWithNewTab(claim.serverName);
  terminal.mount();
  const socket = new WebSocket(claim.wsUrl);
  socket.binaryType = 'arraybuffer';
  // 分享会话：仅允许秒级恢复（ticket 已一次性消费，完整重连不可能），
  // 恢复彻底失败时在终端内宣告分享结束。
  terminal.connectWithWebSocket(socket, undefined, { resumeOnly: true });
}

async function requestSavedServerWebSocket(serverId: number): Promise<WebSocket> {
  const response = await fetch(`/api/servers/${serverId}/connect`, { method: 'POST' });
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    const message = contentType.includes('application/json')
      ? ((await response.json()) as { error?: string }).error
      : null;
    throw new Error(message || `Connection failed (${response.status})`);
  }

  const { wsUrl } = (await response.json()) as { wsUrl?: unknown };
  if (typeof wsUrl !== 'string' || !validateWsUrl(wsUrl)) {
    throw new Error(t('server.invalidWs'));
  }
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  return socket;
}

// ==================== 断开连接处理 ====================

document.getElementById('disconnect-btn')?.addEventListener('click', () => {
  const tm = tabManager;
  if (!tm) return;

  const tab = tm.getActiveTab();
  if (!tab) return;

  tab.sftpPanel?.hide();
  tab.terminal.disconnect();
  tm.closeActiveTab();
});

// ==================== 抽屉分段控制条与互斥联动 ====================

let terminalDrawerControl: LiquidSegmentedDrawerControl | null = null;

/** 收起所有标签页与全局抽屉（SFTP、Agent、命令片段）并重置顶栏抽屉分段条状态 */
function closeAllDrawers(): void {
  tabManager?.closeAllDrawers();
  snippetManager.close();
  syncDrawerSegmentedControl();
}

function syncDrawerSegmentedControl(): void {
  const tab = tabManager?.getActiveTab();
  if (snippetManager.isOpen()) {
    terminalDrawerControl?.setActive('snippet');
  } else if (tab?.sftpPanel?.isVisible()) {
    terminalDrawerControl?.setActive('sftp');
  } else if (tab?.agentPanel?.isOpen) {
    terminalDrawerControl?.setActive('agent');
  } else {
    terminalDrawerControl?.setActive(null);
  }
}

/**
 * 抽屉互斥开关的唯一入口（桌面分段条与移动端菜单按钮共用）。
 * 返回是否真的发生了状态变化（SFTP 未就绪 / Agent 不可用时为 false）。
 */
function applyDrawerToggle(drawer: 'sftp' | 'snippet' | 'agent', open: boolean): boolean {
  const tab = tabManager?.getActiveTab();
  if (drawer === 'sftp') {
    if (open) {
      // SFTP 面板由 TabManager 的 sessionReady 回调初始化，未就绪时不可打开
      if (!tab?.sftpPanel) return false;
      snippetManager.close();
      tab.agentPanel?.hide();
      tab.sftpPanel.show();
    } else {
      tab?.sftpPanel?.hide();
    }
  } else if (drawer === 'snippet') {
    if (open) {
      tab?.sftpPanel?.hide();
      tab?.agentPanel?.hide();
      void snippetManager.open();
    } else {
      snippetManager.close();
    }
  } else {
    if (open) {
      if (!tab?.agentPanel) return false;
      tab.sftpPanel?.hide();
      snippetManager.close();
      tab.agentPanel.show();
    } else {
      tab?.agentPanel?.hide();
    }
  }
  syncDrawerSegmentedControl();
  return true;
}

function initTerminalDrawerControl(): void {
  const drawerBar = document.getElementById('terminal-drawer-segmented-bar');
  if (!drawerBar) return;

  terminalDrawerControl = new LiquidSegmentedDrawerControl(drawerBar, (drawer, open) => {
    if (!applyDrawerToggle(drawer as 'sftp' | 'snippet' | 'agent', open)) {
      // 抽屉不可用：回退透镜的激活态
      terminalDrawerControl?.setActive(null);
    }
  });
}

/**
 * 移动端抽屉入口（#mobile-more-menu 内的 SFTP / AI Agent）。
 * 分段切换器在移动端整体隐藏（.desktop-terminal-action），因此这两个抽屉
 * 必须在移动端菜单里保留平行入口，否则移动端用户将无法使用 SFTP 与 AI 助手。
 */
function initMobileDrawerButtons(): void {
  const closeMenu = () => mobileTerminalController.hideMoreMenu();

  document.getElementById('mobile-sftp-btn')?.addEventListener('click', () => {
    const tab = tabManager?.getActiveTab();
    applyDrawerToggle('sftp', !(tab?.sftpPanel?.isVisible() ?? false));
    closeMenu();
  });

  document.getElementById('mobile-agent-btn')?.addEventListener('click', () => {
    const tab = tabManager?.getActiveTab();
    applyDrawerToggle('agent', !(tab?.agentPanel?.isOpen ?? false));
    closeMenu();
  });
}

// 移动端命令片段按钮
function toggleSnippetManager(): void {
  const tab = tabManager?.getActiveTab();
  if (!snippetManager.isOpen()) {
    tab?.sftpPanel?.hide();
    tab?.agentPanel?.hide();
  }
  snippetManager.toggle();
  syncDrawerSegmentedControl();
}

document.getElementById('mobile-snippets-btn')?.addEventListener('click', toggleSnippetManager);

// ==================== AI Agent 面板设置 ====================

const aiConfigPanel = new AIConfigPanel();

document.getElementById('ai-config-btn')?.addEventListener('click', () => {
  aiConfigPanel.show();
});

const askAISelectionButton = document.getElementById('ask-ai-selection-btn');
askAISelectionButton?.addEventListener('pointerdown', (event) => {
  // 阻止浮动入口的指针事件干扰终端拖拽状态。
  event.stopPropagation();
});
askAISelectionButton?.addEventListener('click', () => {
  tabManager?.askAIAboutActiveSelection();
});

// ==================== 终端搜索 ====================

document.getElementById('search-btn')?.addEventListener('click', () => {
  tabManager?.getActiveTab()?.terminal.toggleSearch();
});

// ==================== 导出终端日志 ====================

document.getElementById('export-btn')?.addEventListener('click', () => {
  tabManager?.getActiveTab()?.terminal.exportToFile();
});

// ==================== 主题切换 ====================

const CUSTOM_THEME_VALUE = '__custom__';
let themeSelectionRevision = 0;
let userThemeSegmentedControl: LiquidSegmentedThemeControl | null = null;
const themeSelectors = Array.from(
  document.querySelectorAll<HTMLSelectElement>('[data-theme-selector]')
);

for (const selector of themeSelectors) {
  selector.addEventListener('change', (e) => {
    themeSelectionRevision++;
    const value = (e.target as HTMLSelectElement).value;
    if (value === CUSTOM_THEME_VALUE) {
      const importedRaw = localStorage.getItem('cloudssh_imported_theme');
      if (importedRaw) {
        try {
          const imported = normalizeImportedTheme(JSON.parse(importedRaw));
          if (imported) applyImportedTheme(imported);
        } catch {
          /* ignore */
        }
      }
    } else if (isBuiltInTheme(value)) {
      applyBuiltInTheme(value);
      // 登录态下回归内置 = 明确放弃自定义主题槽：清除本地导入缓存与自定义选项，
      // 并删除云端槽（幂等）——避免陈旧导入在新设备登录时经云端复现
      if (localStorage.getItem('cloudssh_imported_theme')) {
        removeCustomThemeLocally();
        if (isLoggedIn) {
          void clearCloudTheme().then((ok) => {
            if (!ok) {
              notify(t('theme.syncFailed'), { title: t('feedback.warning'), variant: 'warning' });
            }
          });
        }
      }
    }
    syncThemeSelectors(value);
    localStorage.setItem('cloudssh_theme_selection', value);
  });
}

function ensureCustomOption(): void {
  for (const selector of themeSelectors) {
    let option = selector.querySelector<HTMLOptionElement>(`option[value="${CUSTOM_THEME_VALUE}"]`);
    if (!option) {
      option = document.createElement('option');
      option.value = CUSTOM_THEME_VALUE;
      selector.insertBefore(option, selector.firstChild);
    }
    option.textContent = t('theme.custom');
  }
  userThemeSegmentedControl?.ensureCustomButton();
}

function syncThemeSelectors(value: string): void {
  for (const selector of themeSelectors) {
    selector.value = value;
  }
  userThemeSegmentedControl?.syncFromSelect(value, true);
}

// ==================== 主题导入 ====================

const importThemeButtons = document.querySelectorAll<HTMLElement>('[data-theme-import]');
const importThemeInput = document.getElementById('import-theme-input') as HTMLInputElement | null;

for (const button of importThemeButtons) {
  button.addEventListener('click', () => importThemeInput?.click());
}

importThemeInput?.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > THEME_MAX_BYTES) {
    notify(t('theme.importFailed'), { title: t('theme.importTitle'), variant: 'danger' });
    importThemeInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = normalizeImportedTheme(JSON.parse(ev.target!.result as string));
      if (!data) {
        notify(t('theme.importFailed'), { title: t('theme.importTitle'), variant: 'danger' });
        return;
      }

      localStorage.setItem('cloudssh_imported_theme', JSON.stringify(data));
      themeSelectionRevision++;
      ensureCustomOption();
      syncThemeSelectors(CUSTOM_THEME_VALUE);
      localStorage.setItem('cloudssh_theme_selection', CUSTOM_THEME_VALUE);

      applyImportedTheme(data);
      notify(t('theme.importSuccess'), { variant: 'success' });
      if (isLoggedIn && !(await saveThemeToCloud(data))) {
        notify(t('theme.syncFailed'), { title: t('feedback.warning'), variant: 'warning' });
      }
    } catch {
      notify(t('theme.invalidJson'), { title: t('theme.importTitle'), variant: 'danger' });
    }
  };
  reader.readAsText(file);
  importThemeInput.value = '';
});

// ==================== 主题恢复 ====================

const LEGACY_THEME_MIGRATION: Record<string, BuiltInThemeName> = {
  glacier: 'standard-dark',
  apple: 'liquid-glass',
  gruvbox: 'standard-dark',
  crt: 'cyberpunk',
  glass: 'liquid-glass',
};

/** 恢复主题（在 init 时调用，此时还没有终端实例，只设置 UI 变量） */
function restoreTheme(): void {
  const selection = localStorage.getItem('cloudssh_theme_selection');
  localStorage.removeItem('cloudssh_theme');

  // 旧版内置主题平滑迁移到当前最契合的内置主题
  if (selection && selection in LEGACY_THEME_MIGRATION) {
    const migrated = LEGACY_THEME_MIGRATION[selection];
    localStorage.setItem('cloudssh_theme_selection', migrated);
    applyBuiltInTheme(migrated);
    syncThemeSelectors(migrated);
    return;
  }

  if (isBuiltInTheme(selection)) {
    applyBuiltInTheme(selection);
    syncThemeSelectors(selection);
    return;
  }

  const raw = localStorage.getItem('cloudssh_imported_theme');
  if (raw) {
    try {
      const theme = normalizeImportedTheme(JSON.parse(raw));
      if (!theme) throw new Error('Invalid theme');
      localStorage.setItem('cloudssh_imported_theme', JSON.stringify(theme));
      ensureCustomOption();
      if (selection === CUSTOM_THEME_VALUE) {
        applyImportedTheme(theme);
        syncThemeSelectors(CUSTOM_THEME_VALUE);
        return;
      }
    } catch {
      localStorage.removeItem('cloudssh_imported_theme');
    }
  }

  localStorage.setItem('cloudssh_theme_selection', 'cyberpunk');
  applyBuiltInTheme('cyberpunk');
  syncThemeSelectors('cyberpunk');
}

async function saveThemeToCloud(
  theme: ReturnType<typeof normalizeImportedTheme>
): Promise<boolean> {
  if (!theme) return false;
  try {
    const response = await fetch('/api/user/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme_data: theme }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 登录态下回归内置主题时删除云端自定义主题槽（幂等：无行也成功） */
async function clearCloudTheme(): Promise<boolean> {
  try {
    const response = await fetch('/api/user/theme', { method: 'DELETE' });
    return response.ok;
  } catch {
    return false;
  }
}

/** 清除本地自定义主题缓存并从选择器移除自定义项（不影响当前生效的内置主题） */
function removeCustomThemeLocally(): void {
  localStorage.removeItem('cloudssh_imported_theme');
  for (const selector of themeSelectors) {
    selector.querySelector(`option[value="${CUSTOM_THEME_VALUE}"]`)?.remove();
  }
  userThemeSegmentedControl?.removeCustomButton();
}

/**
 * 登录后恢复账号主题。新浏览器没有本地选择时自动启用云端主题；
 * 已明确选择内置主题的当前浏览器只缓存云端主题，不强制覆盖本地选择。
 */
async function restoreCloudTheme(
  initialSelection: string | null,
  expectedSelectionRevision: number
): Promise<void> {
  try {
    const response = await fetch('/api/user/theme');
    if (!response.ok) return;
    const payload = (await response.json()) as { theme?: unknown };
    const cloudTheme = normalizeImportedTheme(payload.theme);

    if (cloudTheme) {
      // 用户已在请求期间切换或导入主题时，不用较旧的云端响应覆盖当前操作。
      if (themeSelectionRevision !== expectedSelectionRevision) return;
      localStorage.setItem('cloudssh_imported_theme', JSON.stringify(cloudTheme));
      ensureCustomOption();
      if (initialSelection === null || initialSelection === CUSTOM_THEME_VALUE) {
        localStorage.setItem('cloudssh_theme_selection', CUSTOM_THEME_VALUE);
        applyImportedTheme(cloudTheme);
        syncThemeSelectors(CUSTOM_THEME_VALUE);
      }
      return;
    }

    // 匿名状态下已导入且当前正在使用的本地主题，在首次登录后补充同步到账号。
    // 仅当本地选择停留在自定义主题时回填：排除「残留但未使用」的陈旧导入被上传到
    // 全新账号的云端主题槽（如密码模式新建管理员搭配既有浏览器状态）。
    const selection = localStorage.getItem('cloudssh_theme_selection');
    if (selection !== CUSTOM_THEME_VALUE) return;
    const localRaw = localStorage.getItem('cloudssh_imported_theme');
    if (!localRaw) return;
    const localTheme = normalizeImportedTheme(JSON.parse(localRaw));
    if (localTheme) await saveThemeToCloud(localTheme);
  } catch {
    // 云端不可用时继续使用本地主题，不影响 SSH 主流程。
  }
}

// ==================== 初始化 ====================

/**
 * macOS 26 液态玻璃动态指针天光追踪：
 * 仅在 liquid 风格下监听 pointermove 并通过 requestAnimationFrame 节流更新 --mx 和 --my，
 * 纯变量传导，零 DOM 重排，GPU 仅更新 radial-gradient 聚光位置。
 */
function initPointerSpecularTracking(): void {
  let rafId: number | null = null;
  let targetCard: HTMLElement | null = null;
  let px = 50;
  let py = 0;

  document.addEventListener(
    'pointermove',
    (e: PointerEvent) => {
      if (document.documentElement.dataset.uiStyle !== 'liquid') return;
      const card = (e.target as HTMLElement | null)?.closest?.(
        '.server-card, .cyber-box'
      ) as HTMLElement | null;
      if (!card) {
        targetCard = null;
        return;
      }
      const rect = card.getBoundingClientRect();
      targetCard = card;
      px = Math.round(((e.clientX - rect.left) / rect.width) * 100);
      py = Math.round(((e.clientY - rect.top) / rect.height) * 100);

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          if (targetCard) {
            targetCard.style.setProperty('--mx', `${px}%`);
            targetCard.style.setProperty('--my', `${py}%`);
          }
          rafId = null;
        });
      }
    },
    { passive: true }
  );

  document.addEventListener(
    'pointerleave',
    () => {
      if (targetCard) {
        targetCard.style.setProperty('--mx', '50%');
        targetCard.style.setProperty('--my', '0%');
        targetCard = null;
      }
    },
    { passive: true }
  );
}

/** #password-setup 路由消费：命中则打开生成器并清地址栏（init 与 hashchange 共用） */
function consumeAdminSetupRoute(): void {
  if (window.location.hash !== '#password-setup') return;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  openAdminHashGeneratorDialog();
}

async function init(): Promise<void> {
  initI18n();
  initUserSpaceMobileMenu();
  initServerPaginationBreakpoints();
  bindBackToTerminalButtons();
  initPointerSpecularTracking();
  const userSegmentedContainer = document.getElementById('user-theme-segmented-container');
  const userSelect = document.getElementById('user-theme-selector') as HTMLSelectElement | null;
  if (userSegmentedContainer && userSelect) {
    userThemeSegmentedControl = new LiquidSegmentedThemeControl(userSegmentedContainer, userSelect);
  }

  const drawerBar = document.getElementById('terminal-drawer-segmented-bar');
  if (drawerBar) {
    initTerminalDrawerControl();
  }
  initMobileDrawerButtons();

  document.addEventListener('cloudssh:active-terminal-change', () => {
    snippetManager.close();
    syncDrawerSegmentedControl();
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('#agent-close-btn, #sftp-close-btn, #snippet-close-btn')) {
      setTimeout(() => syncDrawerSegmentedControl(), 50);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setTimeout(() => syncDrawerSegmentedControl(), 50);
    }
  });
  mobileTerminalController.start();
  onLocaleChange(() => {
    if (localStorage.getItem('cloudssh_imported_theme')) ensureCustomOption();
    tabManager?.refreshTranslations();
  });
  const initialThemeSelection = localStorage.getItem('cloudssh_theme_selection');
  restoreTheme();
  // 设置版权年份
  const copyrightYearSpan = document.getElementById('copyright-year');
  if (copyrightYearSpan) {
    copyrightYearSpan.textContent = new Date().getFullYear().toString();
  }

  const shareToken = takeShareTokenFromLocation();
  if (shareToken) {
    renderShareLanding(shareToken, showSharedTerminal);
    return;
  }

  // 独立终端标签页模式：URL 包含 wsUrl 参数
  if (isTerminalTab()) {
    initTerminalTab();
    return;
  }

  // #password-setup：单管理员密码登录生成器直路由（全模式可用）。GitHub 模式
  // 页脚不展示生成器入口（升级零感知），切换密码模式/轮换密码均经此 URL
  // 进入（README 引导）。同时监听 hashchange：同页 hash 导航不触发重载，
  // 用户在地址栏粘贴带 hash 的同页 URL 也能打开。
  consumeAdminSetupRoute();
  window.addEventListener('hashchange', consumeAdminSetupRoute);

  try {
    // 检查是否已登录
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      const user = await meRes.json();
      showUserSpace(user);
      void restoreCloudTheme(initialThemeSelection, themeSelectionRevision);
      return;
    }
  } catch {
    // /api/auth/me 失败，继续显示匿名连接表单
  }

  // 未登录 → 显示匿名连接表单
  showAuthSection();
}

// 导出供 auth-form、server-list 和测试套件使用
export { getTabManager, showTerminalWithNewTab, validateWsUrl, closeAllDrawers, showConnectionPage };

init();
