import { THEMES } from './terminal';
import type { SSHTerminal } from './terminal';
import { ConnectionForm } from './auth-form';
import { ServerList } from './server-list';
import { TabManager } from './tab-manager';
import { AIConfigPanel } from './ai-config';

// ==================== 全局状态 ====================

let tabManager: TabManager | null = null;
let connectionForm: ConnectionForm | null = null;
let serverList: ServerList | null = null;
let isLoggedIn = false;

/** 获取或初始化 TabManager 单例 */
function getTabManager(): TabManager {
  if (!tabManager) {
    tabManager = new TabManager('tab-bar', 'terminal-area');
    tabManager.setAllTabsClosedHandler(() => {
      showOfflineUI();
    });
    tabManager.setLoggedIn(isLoggedIn);

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

// ==================== 独立终端标签页模式 ====================

function isTerminalTab(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('wsUrl');
}

function validateWsUrl(wsUrl: string): boolean {
  try {
    const url = new URL(wsUrl);
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return false;
    return url.origin === window.location.origin ||
           url.origin === window.location.origin.replace(/^http/, 'ws');
  } catch {
    return false;
  }
}

function initTerminalTab(): void {
  const params = new URLSearchParams(window.location.search);
  const wsUrl = params.get('wsUrl')!;
  const serverName = params.get('name') || 'Server';
  const host = params.get('host') || '';
  const port = parseInt(params.get('port') || '0') || 0;

  if (!validateWsUrl(wsUrl)) {
    document.body.innerHTML = '<div style="color:var(--error);padding:2em;font-family:monospace;">Error: Invalid or untrusted WebSocket URL.</div>';
    return;
  }

  // 隐藏所有非终端元素
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.remove('hidden');
  document.getElementById('terminal-section')!.classList.add('flex');
  document.body.classList.add('terminal-active');

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

function showAuthSection(): void {
  document.getElementById('auth-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.add('hidden');
  document.getElementById('terminal-section')!.classList.remove('flex');
  document.body.classList.remove('terminal-active');
  document.getElementById('server-modal')!.classList.add('hidden');
  document.getElementById('server-modal')!.classList.remove('flex');

  if (!connectionForm) {
    connectionForm = new ConnectionForm({
      getTabManager,
    });
  }
}

function showUserSpace(user: { id: number; github_id: number; username: string; avatar_url: string }): void {
  isLoggedIn = true;
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('flex');
  document.getElementById('terminal-section')!.classList.add('hidden');
  document.getElementById('terminal-section')!.classList.remove('flex');
  document.body.classList.remove('terminal-active');

  // Show agent toggle button for logged-in users
  document.getElementById('agent-toggle-btn')?.classList.remove('hidden');

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
    (wsUrl: string, serverName: string, hostInfo?: { host: string; port: number }) => {
      showTerminalFromServer(wsUrl, serverName, hostInfo);
    }
  );
}

/** 显示连接页面（匿名 → auth-form，登录 → 服务器列表） */
function showConnectionPage(): void {
  // 如果还有活跃标签，不需要隐藏终端区域；只需要覆盖显示连接页面
  // 但为了简单起见，我们先切回对应的入口页面
  if (isLoggedIn) {
    document.getElementById('terminal-section')!.classList.add('hidden');
    document.getElementById('terminal-section')!.classList.remove('flex');
    document.body.classList.remove('terminal-active');
    document.getElementById('user-space-section')!.classList.remove('hidden');
    document.getElementById('user-space-section')!.classList.add('flex');
  } else {
    document.getElementById('terminal-section')!.classList.add('hidden');
    document.getElementById('terminal-section')!.classList.remove('flex');
    document.body.classList.remove('terminal-active');
    showAuthSection();
  }
}

function showOfflineUI(): void {
  if (isTerminalTab()) {
    window.close();
    return;
  }

  // 如果还有其他标签，不回到连接页
  if (tabManager && tabManager.hasAnyTab()) {
    return;
  }

  const termSection = document.getElementById('terminal-section');
  if (termSection) {
    termSection.classList.add('hidden');
    termSection.classList.remove('flex');
    document.body.classList.remove('terminal-active');
  }

  if (isLoggedIn) {
    document.getElementById('user-space-section')?.classList.remove('hidden');
    document.getElementById('user-space-section')?.classList.add('flex');
  } else {
    showAuthSection();
  }

  document.getElementById('status-text')!.innerHTML = '<span class="w-2 h-2 bg-surface-dot inline-block"></span> STATUS: OFFLINE';
}

/** 在终端页面创建新标签并显示终端视图 */
function showTerminalWithNewTab(
  label: string,
  displayLabel: string,
  hostInfo?: { host: string; port: number; username?: string }
): { tab: ReturnType<TabManager['createTab']>; terminal: SSHTerminal } {
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.remove('hidden');
  document.getElementById('terminal-section')!.classList.add('flex');
  document.body.classList.add('terminal-active');

  const tm = getTabManager();
  const tab = tm.createTab(displayLabel, hostInfo);

  return { tab, terminal: tab.terminal };
}

function showTerminalFromServer(wsUrl: string, serverName: string, hostInfo?: { host: string; port: number }): void {
  if (!validateWsUrl(wsUrl)) {
    alert('Invalid WebSocket URL');
    return;
  }

  const { terminal } = showTerminalWithNewTab(
    serverName,
    serverName,
    hostInfo
  );

  terminal.mount();

  // 通过 wsUrl（含 one-time-token）建立连接
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  terminal.connectWithWebSocket(ws, hostInfo);
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

// ==================== SFTP 面板 ====================

document.getElementById('sftp-toggle-btn')?.addEventListener('click', () => {
  const tab = tabManager?.getActiveTab();
  if (!tab) return;

  if (!tab.sftpPanel) {
    // SFTP 面板由 TabManager 的 sessionReady 回调初始化
    // 如果还没有初始化，说明 SSH 还没就绪
    return;
  }
  tab.sftpPanel.toggle();
});

// ==================== AI Agent 面板 ====================

const aiConfigPanel = new AIConfigPanel();

document.getElementById('agent-toggle-btn')?.addEventListener('click', () => {
  const tab = tabManager?.getActiveTab();
  if (!tab?.agentPanel) return;
  tab.agentPanel.toggle();
});

/** 显示 AI 配置面板（从 server-list 调用） */
export function showAIConfig(): void {
  aiConfigPanel.show();
}

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
const themeSelector = document.getElementById('theme-selector') as HTMLSelectElement | null;

/** 获取一个可用于主题操作的终端实例（当前活跃标签的终端） */
function getThemeTerminal(): SSHTerminal | null {
  return tabManager?.getActiveTab()?.terminal || null;
}

themeSelector?.addEventListener('change', (e) => {
  const value = (e.target as HTMLSelectElement).value;
  if (value === CUSTOM_THEME_VALUE) {
    const importedRaw = localStorage.getItem('cloudssh_imported_theme');
    if (importedRaw) {
      try {
        getThemeTerminal()?.applyImportedTheme(JSON.parse(importedRaw));
      } catch { /* ignore */ }
    }
  } else {
    getThemeTerminal()?.setTheme(value as keyof typeof THEMES);
    localStorage.removeItem('cloudssh_imported_theme');
  }
  localStorage.setItem('cloudssh_theme_selection', value);
});

function ensureCustomOption(): void {
  if (!themeSelector) return;
  if (!themeSelector.querySelector(`option[value="${CUSTOM_THEME_VALUE}"]`)) {
    const opt = document.createElement('option');
    opt.value = CUSTOM_THEME_VALUE;
    opt.textContent = 'Custom';
    themeSelector.insertBefore(opt, themeSelector.firstChild);
  }
}

// ==================== 主题导入 ====================

const importThemeBtn = document.getElementById('import-theme-btn');
const importThemeInput = document.getElementById('import-theme-input') as HTMLInputElement | null;

importThemeBtn?.addEventListener('click', () => {
  importThemeInput?.click();
});

importThemeInput?.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target!.result as string);
      if (!data.ui || typeof data.ui !== 'object') {
        alert('无效的主题文件：缺少 "ui" 字段');
        return;
      }

      // 保存到 localStorage
      localStorage.setItem('cloudssh_imported_theme', JSON.stringify(data));

      // 尝试保存到云端
      try {
        await fetch('/api/user/theme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme_data: data }),
        });
      } catch { /* 未登录或网络错误，忽略 */ }

      // 添加 Custom 选项并选中
      ensureCustomOption();
      if (themeSelector) themeSelector.value = CUSTOM_THEME_VALUE;
      localStorage.setItem('cloudssh_theme_selection', CUSTOM_THEME_VALUE);

      // 直接应用主题，不刷新页面（避免断开 WebSocket）
      getThemeTerminal()?.applyImportedTheme(data);
    } catch {
      alert('无效的 JSON 文件');
    }
  };
  reader.readAsText(file);
  importThemeInput.value = '';
});

// ==================== 主题恢复 ====================

/** 恢复主题（在 init 时调用，此时还没有终端实例，只设置 UI 变量） */
async function restoreTheme(): Promise<void> {
  const selection = localStorage.getItem('cloudssh_theme_selection');

  // 尝试从云端加载自定义主题
  let cloudTheme: Record<string, unknown> | null = null;
  try {
    const res = await fetch('/api/user/theme');
    if (res.ok) {
      const { theme } = await res.json() as { theme: Record<string, unknown> | null };
      if (theme) {
        cloudTheme = theme;
        // 同步到 localStorage
        localStorage.setItem('cloudssh_imported_theme', JSON.stringify(theme));
        ensureCustomOption();
      }
    }
  } catch { /* 未登录，忽略 */ }

  // 如果云端没有但 localStorage 有，也添加 Custom 选项
  if (!cloudTheme) {
    const localRaw = localStorage.getItem('cloudssh_imported_theme');
    if (localRaw) {
      try {
        JSON.parse(localRaw);
        ensureCustomOption();
      } catch {
        localStorage.removeItem('cloudssh_imported_theme');
      }
    }
  }

  // 恢复选择：应用 UI 变量（终端主题在创建标签时应用）
  if (selection === CUSTOM_THEME_VALUE) {
    const raw = localStorage.getItem('cloudssh_imported_theme');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        // 应用 UI 变量
        if (data.ui) {
          const root = document.documentElement;
          Object.entries(data.ui).forEach(([prop, val]) => {
            root.style.setProperty(prop, val as string);
          });
        }
        if (themeSelector) themeSelector.value = CUSTOM_THEME_VALUE;
        return;
      } catch { /* ignore */ }
    }
  }

  if (selection && THEMES[selection as keyof typeof THEMES]) {
    // 应用 UI 变量（不需要终端实例）
    const { UI_THEMES } = await import('./terminal');
    const uiVars = UI_THEMES[selection as keyof typeof THEMES];
    if (uiVars) {
      const root = document.documentElement;
      Object.entries(uiVars).forEach(([prop, val]) => {
        root.style.setProperty(prop, val);
      });
    }
    if (themeSelector) themeSelector.value = selection;
    return;
  }

  // 默认主题：只设置 UI 变量
  const { UI_THEMES } = await import('./terminal');
  const uiVars = UI_THEMES.cyberpunk;
  if (uiVars) {
    const root = document.documentElement;
    Object.entries(uiVars).forEach(([prop, val]) => {
      root.style.setProperty(prop, val);
    });
  }
  if (themeSelector) themeSelector.value = 'cyberpunk';
}

// ==================== 初始化 ====================

async function init(): Promise<void> {
  await restoreTheme();
  // 设置版权年份
  const copyrightYearSpan = document.getElementById('copyright-year');
  if (copyrightYearSpan) {
    copyrightYearSpan.textContent = new Date().getFullYear().toString();
  }

  // 独立终端标签页模式：URL 包含 wsUrl 参数
  if (isTerminalTab()) {
    initTerminalTab();
    return;
  }

  try {
    // 检查是否已登录
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      const user = await meRes.json();
      showUserSpace(user);
      return;
    }
  } catch {
    // /api/auth/me 失败，继续显示匿名连接表单
  }

  // 未登录 → 显示匿名连接表单
  showAuthSection();
}

// 导出供 auth-form 和 server-list 使用
export { getTabManager, showTerminalWithNewTab, validateWsUrl };

init();
