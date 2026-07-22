import { WindowManager, WindowHandle } from '../wm/window-manager';
import { ServerList } from '../server-list';
import { openTerminalFromWsUrl } from './terminal-app';

type User = { id: number; github_id: number; username: string; avatar_url: string };

let serversWin: WindowHandle | null = null;
let listInited = false;

/**
 * 打开“服务器”窗口：把 index.html 中的 #server-space-host 迁入窗口 body，
 * 首次构造 ServerList（其 onConnect 转为开终端窗口）。
 * 复用现有 ServerList → “记住多台 VPS” 与增删改由其自身处理。
 */
export function openServersWindow(wm: WindowManager, user: User, onLogout: () => void): void {
  // 已打开则聚焦，避免重复窗口
  if (serversWin) { serversWin.focus(); return; }

  const host = document.getElementById('server-space-host');
  if (!host) return;

  const win = wm.openWindow({
    title: '服务器', icon: 'dns',
    width: 860, height: 580, minWidth: 460, minHeight: 340,
  });
  serversWin = win;

  win.bodyEl.appendChild(host);
  host.classList.remove('hidden');

  win.onClose(() => {
    // 节点移回 #app 并隐藏，供下次复用（不销毁已绑定事件的 ServerList）
    host.classList.add('hidden');
    document.getElementById('app')?.appendChild(host);
    serversWin = null;
  });

  // ServerList 只构造一次：其事件绑定在 #server-space-host / #server-modal 节点上
  if (!listInited) {
    listInited = true;
    // eslint-disable-next-line no-new
    new ServerList(
      user,
      onLogout,
      (wsUrl: string, serverName: string, hostInfo?: { host: string; port: number }) => {
        openTerminalFromWsUrl(wm, { wsUrl, name: serverName, hostInfo });
      },
    );
  }
}
