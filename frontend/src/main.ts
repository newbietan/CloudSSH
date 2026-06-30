import { SSHTerminal, THEMES } from './terminal';
import { ConnectionForm } from './auth-form';
import { ServerList } from './server-list';
import { SFTPPanel } from './sftp-panel';

// ==================== 全局状态 ====================

const terminal = new SSHTerminal('terminal-container');
let connectionForm: ConnectionForm | null = null;
let serverList: ServerList | null = null;
let isLoggedIn = false;
let sftpPanel: SFTPPanel | null = null;

terminal.setSessionClosedHandler(() => {
  showOfflineUI();
});

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

  // 更新终端状态栏
  document.getElementById('term-host')!.textContent = `Server: ${serverName}`;
  document.getElementById('term-user')!.textContent = '';
  document.getElementById('term-port')!.textContent = '';

  terminal.mount();

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  terminal.connectWithWebSocket(ws);
}

// ==================== 页面切换 ====================

function showAuthSection(): void {
  document.getElementById('auth-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.add('hidden');
  document.getElementById('terminal-section')!.classList.remove('flex');
  document.getElementById('server-modal')!.classList.add('hidden');
  document.getElementById('server-modal')!.classList.remove('flex');

  if (!connectionForm) {
    connectionForm = new ConnectionForm(terminal);
  }
}

function showUserSpace(user: { id: number; github_id: number; username: string; avatar_url: string }): void {
  isLoggedIn = true;
  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('hidden');
  document.getElementById('user-space-section')!.classList.add('flex');
  document.getElementById('terminal-section')!.classList.add('hidden');
  document.getElementById('terminal-section')!.classList.remove('flex');

  serverList = new ServerList(
    user,
    // onLogout 回调
    () => {
      isLoggedIn = false;
      serverList = null;
      showAuthSection();
    }
  );
}

function showOfflineUI(): void {
  if (isTerminalTab()) {
    window.close();
    return;
  }

  // Clean up SFTP panel
  if (sftpPanel) {
    sftpPanel.dispose();
    sftpPanel = null;
    terminal.setSFTPMessageHandler(() => {});
    terminal.setSFTPBinaryHandler(() => {});
  }

  const termSection = document.getElementById('terminal-section');
  if (termSection) {
    termSection.classList.add('hidden');
    termSection.classList.remove('flex');
  }

  if (isLoggedIn) {
    document.getElementById('user-space-section')?.classList.remove('hidden');
    document.getElementById('user-space-section')?.classList.add('flex');
  } else {
    showAuthSection();
  }

  document.getElementById('status-text')!.innerHTML = '<span class="w-2 h-2 bg-surface-dot inline-block"></span> STATUS: OFFLINE';
}

function showTerminalFromServer(wsUrl: string, serverName: string): void {
  if (!validateWsUrl(wsUrl)) {
    alert('Invalid WebSocket URL');
    return;
  }

  document.getElementById('auth-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.add('hidden');
  document.getElementById('user-space-section')!.classList.remove('flex');
  document.getElementById('terminal-section')!.classList.remove('hidden');
  document.getElementById('terminal-section')!.classList.add('flex');

  // 更新终端状态栏
  document.getElementById('term-host')!.textContent = `Server: ${serverName}`;
  document.getElementById('term-user')!.textContent = '';
  document.getElementById('term-port')!.textContent = '';

  terminal.mount();

  // 通过 wsUrl（含 one-time-token）建立连接
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  terminal.connectWithWebSocket(ws);
}

// ==================== 断开连接处理 ====================

document.getElementById('disconnect-btn')?.addEventListener('click', () => {
  if (sftpPanel) {
    sftpPanel.hide();
  }
  terminal.disconnect();
  showOfflineUI();
});

// ==================== SFTP 面板 ====================

function initSFTPPanel(): void {
  if (sftpPanel) {
    sftpPanel.dispose();
  }

  sftpPanel = new SFTPPanel(
    (msg) => terminal.sendSFTPMessage(msg),
    (data) => terminal.sendSFTPBinary(data),
  );
  sftpPanel.bindEvents();

  sftpPanel.setOnClosedCallback(() => {
    terminal.resetSFTPDownloadActive();
  });

  terminal.setSFTPMessageHandler((msg) => sftpPanel?.handleMessage(msg));
  terminal.setSFTPBinaryHandler((data) => sftpPanel?.handleBinaryData(data));
}

document.getElementById('sftp-toggle-btn')?.addEventListener('click', () => {
  if (!sftpPanel) {
    initSFTPPanel();
  }
  sftpPanel?.toggle();
});

// ==================== 主题切换 ====================

const CUSTOM_THEME_VALUE = '__custom__';
const themeSelector = document.getElementById('theme-selector') as HTMLSelectElement | null;

themeSelector?.addEventListener('change', (e) => {
  const value = (e.target as HTMLSelectElement).value;
  if (value === CUSTOM_THEME_VALUE) {
    const importedRaw = localStorage.getItem('cloudssh_imported_theme');
    if (importedRaw) {
      try {
        terminal.applyImportedTheme(JSON.parse(importedRaw));
      } catch { /* ignore */ }
    }
  } else {
    terminal.setTheme(value as keyof typeof THEMES);
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
      terminal.applyImportedTheme(data);
    } catch {
      alert('无效的 JSON 文件');
    }
  };
  reader.readAsText(file);
  importThemeInput.value = '';
});

// ==================== 主题恢复 ====================

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

  // 恢复选择
  if (selection === CUSTOM_THEME_VALUE) {
    const raw = localStorage.getItem('cloudssh_imported_theme');
    if (raw) {
      try {
        terminal.applyImportedTheme(JSON.parse(raw));
        if (themeSelector) themeSelector.value = CUSTOM_THEME_VALUE;
        return;
      } catch { /* ignore */ }
    }
  }

  if (selection && THEMES[selection as keyof typeof THEMES]) {
    terminal.setTheme(selection as keyof typeof THEMES);
    if (themeSelector) themeSelector.value = selection;
    return;
  }

  // 默认主题
  terminal.setTheme('cyberpunk');
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

init();
