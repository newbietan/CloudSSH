import { SSHTerminal } from './terminal';
import type { WindowHandle } from './wm/window-manager';
import { Desktop } from './desktop';
import { ConnectionForm } from './auth-form';
import { openServersWindow } from './apps/servers-app';
import { createTerminalWindow } from './apps/terminal-app';
import { AIConfigPanel } from './ai-config';

type User = { id: number; github_id: number; username: string; avatar_url: string };

let desktop: Desktop | null = null;
let connectionForm: ConnectionForm | null = null;

function getDesktop(): Desktop {
  if (!desktop) desktop = new Desktop();
  return desktop;
}

/** 隐藏登录页、显示桌面并创建终端窗口（注入给 ConnectionForm 的匿名连接使用） */
function createTerminalWindowOnDesktop(
  opts: { name: string; hostInfo?: { host: string; port: number } },
): { terminal: SSHTerminal; win: WindowHandle } {
  document.getElementById('auth-section')!.classList.add('hidden');
  const d = getDesktop();
  d.show();
  return createTerminalWindow(d.wm, opts);
}

/** 未登录：显示匿名连接表单 */
function showAuthSection(): void {
  getDesktop().hide();
  document.getElementById('auth-section')!.classList.remove('hidden');
  if (!connectionForm) {
    connectionForm = new ConnectionForm({ createTerminalWindow: createTerminalWindowOnDesktop });
  }
}

/** 已登录：进入桌面，注册“服务器”App */
function showDesktop(user: User): void {
  document.getElementById('auth-section')!.classList.add('hidden');
  const d = getDesktop();
  d.show();
  d.registerApps([
    { id: 'servers', title: '服务器', icon: 'dns', open: () => openServersWindow(d.wm, user, onLogout) },
  ]);
}

function onLogout(): void {
  fetch('/api/auth/logout', { method: 'POST' }).finally(() => location.reload());
}

// ==================== AI 配置面板（供 server-list 动态调用） ====================

const aiConfigPanel = new AIConfigPanel();

/** 显示 AI 配置面板（server-list 通过 import('./main') 动态调用） */
export function showAIConfig(): void {
  aiConfigPanel.show();
}

// ==================== 初始化 ====================

async function init(): Promise<void> {
  const yearEl = document.getElementById('user-copyright-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear().toString();

  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      showDesktop((await res.json()) as User);
      return;
    }
  } catch {
    // /api/auth/me 失败 → 未登录，显示匿名连接表单
  }
  showAuthSection();
}

init();
