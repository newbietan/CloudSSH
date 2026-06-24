import { SSHTerminal } from './terminal';
import { ConnectionForm } from './auth-form';
import { ServerList } from './server-list';

// ==================== 全局状态 ====================

const terminal = new SSHTerminal('terminal-container');
let connectionForm: ConnectionForm | null = null;
let serverList: ServerList | null = null;
let isLoggedIn = false;

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
    document.body.innerHTML = '<div style="color:red;padding:2em;font-family:monospace;">Error: Invalid or untrusted WebSocket URL.</div>';
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

  document.getElementById('status-text')!.innerHTML = '<span class="w-2 h-2 bg-[#353534] inline-block"></span> STATUS: OFFLINE';
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
  terminal.disconnect();
  showOfflineUI();
});

// ==================== 主题切换 ====================

document.getElementById('theme-selector')?.addEventListener('change', (e) => {
  const theme = (e.target as HTMLSelectElement).value as any;
  terminal.setTheme(theme);
});

// ==================== 初始化 ====================

async function init(): Promise<void> {
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
