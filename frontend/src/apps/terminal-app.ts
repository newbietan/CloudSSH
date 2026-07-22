import { WindowManager, WindowHandle } from '../wm/window-manager';
import { SSHTerminal } from '../terminal';
import { SFTPPanel } from '../sftp-panel';
import { notify } from '../ui-feedback';

let seq = 0;

/** 校验 wsUrl 为同源 ws/wss，防止连接到不受信任地址 */
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

export interface CreateTerminalWindowOptions {
  name: string;
  hostInfo?: { host: string; port: number };
}

/**
 * 在桌面上打开一个终端窗口，装配 SSHTerminal 与 SFTPPanel，返回句柄。
 * 不负责建立连接——由调用者决定 connect(config)（匿名）或 connectWithWebSocket(ws)（服务器列表）。
 */
export function createTerminalWindow(
  wm: WindowManager,
  opts: CreateTerminalWindowOptions,
): { terminal: SSHTerminal; win: WindowHandle } {
  const win = wm.openWindow({
    title: opts.name, icon: 'terminal',
    width: 760, height: 480, minWidth: 360, minHeight: 220,
  });

  // SSHTerminal 需要一个带 id 的容器
  const containerId = `term-host-${++seq}`;
  const mountEl = document.createElement('div');
  mountEl.id = containerId;
  mountEl.style.cssText = 'position:absolute;inset:0;';
  win.bodyEl.appendChild(mountEl);

  const terminal = new SSHTerminal(containerId);
  let sftp: SFTPPanel | null = null;

  terminal.setSessionReadyHandler(() => {
    win.setDisconnected(false);
    if (!sftp) {
      sftp = new SFTPPanel(() => terminal.getSFTPWebSocketUrl());
      sftp.bindEvents();
    }
    sftp.handleSSHReady();
  });
  terminal.setSessionClosedHandler(() => {
    win.setDisconnected(true);
    sftp?.hide();
  });

  // 窗口缩放/最大化/还原 → 终端重排
  win.onResize(() => terminal.fit());

  // 关窗清理（镜像 TabManager.closeTab）
  win.onClose(() => {
    sftp?.dispose();
    sftp = null;
    terminal.disconnect();
    terminal.dispose();
  });

  // 工具栏 SFTP 切换按钮（浮于窗口 body 右上角）
  const sftpBtn = document.createElement('button');
  sftpBtn.title = 'SFTP 文件传输';
  sftpBtn.className = 'absolute top-1 right-1 z-10 p-1';
  sftpBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">folder_open</span>';
  sftpBtn.addEventListener('click', () => sftp?.toggle());
  win.bodyEl.appendChild(sftpBtn);

  terminal.mount();
  return { terminal, win };
}

/** 服务器列表路径：用后端返回的 wsUrl（含 one-time-token）开终端窗口并连接 */
export function openTerminalFromWsUrl(
  wm: WindowManager,
  opts: { wsUrl: string; name: string; hostInfo?: { host: string; port: number } },
): void {
  if (!validateWsUrl(opts.wsUrl)) {
    notify('服务器返回了无效或不受信任的 WebSocket 地址。', { title: '无法建立连接', variant: 'danger' });
    return;
  }
  const { terminal } = createTerminalWindow(wm, { name: opts.name, hostInfo: opts.hostInfo });
  const ws = new WebSocket(opts.wsUrl);
  ws.binaryType = 'arraybuffer';
  terminal.connectWithWebSocket(ws, opts.hostInfo);
}
