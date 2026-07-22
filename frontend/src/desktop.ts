import { WindowManager } from './wm/window-manager';
import type { TaskbarItem } from './wm/window-logic';

export interface DesktopApp {
  id: string;
  title: string;
  icon: string;         // Material Symbols
  open: () => void;     // 打开该 App（装配窗口）
}

export class Desktop {
  readonly wm: WindowManager;
  private apps: DesktopApp[] = [];
  private taskbarItemsEl: HTMLElement;

  constructor() {
    const host = document.getElementById('window-host')!;
    this.wm = new WindowManager(host);
    this.taskbarItemsEl = document.getElementById('taskbar-items')!;
    this.wm.onChange((items) => this.renderTaskbar(items));
    this.bindStartMenu();
    this.startClock();
  }

  show(): void {
    document.getElementById('desktop')!.classList.remove('hidden');
  }
  hide(): void {
    document.getElementById('desktop')!.classList.add('hidden');
  }

  /** 注册桌面 App（渲染桌面图标 + 开始菜单项） */
  registerApps(apps: DesktopApp[]): void {
    this.apps = apps;
    this.renderIcons();
    this.renderStartMenu();
  }

  private renderIcons(): void {
    const el = document.getElementById('desktop-icons')!;
    el.innerHTML = '';
    for (const app of this.apps) {
      const icon = document.createElement('button');
      icon.className = 'w-20 h-20 flex flex-col items-center justify-center gap-1 text-xs rounded hover:bg-white/10';
      icon.innerHTML = `<span class="material-symbols-outlined" style="font-size:28px;">${app.icon}</span><span>${app.title}</span>`;
      icon.addEventListener('dblclick', () => app.open());
      el.appendChild(icon);
    }
  }

  private renderStartMenu(): void {
    const menu = document.getElementById('start-menu')!;
    menu.innerHTML = '';
    for (const app of this.apps) {
      const item = document.createElement('button');
      item.className = 'w-full flex items-center gap-2 px-2 py-2 text-sm text-left hover:bg-white/10';
      item.innerHTML = `<span class="material-symbols-outlined" style="font-size:18px;">${app.icon}</span>${app.title}`;
      item.addEventListener('click', () => { menu.classList.add('hidden'); app.open(); });
      menu.appendChild(item);
    }
  }

  private bindStartMenu(): void {
    const btn = document.getElementById('start-btn')!;
    const menu = document.getElementById('start-menu')!;
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', () => menu.classList.add('hidden'));
  }

  private renderTaskbar(items: TaskbarItem[]): void {
    this.taskbarItemsEl.innerHTML = '';
    for (const it of items) {
      const btn = document.createElement('button');
      btn.className = `px-3 h-9 flex items-center gap-2 text-xs rounded ${it.active ? 'bg-white/15' : 'hover:bg-white/10'} ${it.minimized ? 'opacity-60' : ''}`;
      btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;">${it.icon}</span><span class="max-w-[120px] truncate">${this.escape(it.title)}</span>`;
      btn.addEventListener('click', () => {
        if (it.active && !it.minimized) this.wm.minimize(it.id);
        else this.wm.focus(it.id);
      });
      this.taskbarItemsEl.appendChild(btn);
    }
  }

  private startClock(): void {
    const el = document.getElementById('taskbar-clock')!;
    const tick = () => {
      const d = new Date();
      el.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    tick();
    setInterval(tick, 1000 * 15);
  }

  private escape(s: string): string {
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
}
