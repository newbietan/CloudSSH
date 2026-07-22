import { clampPosition, topZIndex, deriveTaskbar, TaskbarItem } from './window-logic';

export interface OpenWindowOptions {
  title: string;
  icon: string;              // Material Symbols 图标名
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  x?: number;
  y?: number;
}

export interface WindowHandle {
  readonly id: string;
  readonly bodyEl: HTMLElement;      // 内容挂载点
  focus(): void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  setTitle(title: string): void;
  setDisconnected(disconnected: boolean): void;
  onResize(cb: () => void): void;    // 窗口尺寸变化（缩放/最大化/还原）
  onClose(cb: () => void): void;
}

interface WinRecord {
  id: string;
  opts: OpenWindowOptions;
  rootEl: HTMLDivElement;
  bodyEl: HTMLElement;
  titleEl: HTMLElement;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  prevRect?: { x: number; y: number; width: number; height: number };
  resizeCbs: Array<() => void>;
  closeCbs: Array<() => void>;
}

const BASE_Z = 100;

export class WindowManager {
  private host: HTMLElement;
  private wins = new Map<string, WinRecord>();
  private activeId: string | null = null;
  private counter = 0;
  private changeCbs: Array<(items: TaskbarItem[]) => void> = [];

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** 订阅窗口集合/状态变化（供任务栏渲染） */
  onChange(cb: (items: TaskbarItem[]) => void): void {
    this.changeCbs.push(cb);
  }

  private emitChange(): void {
    const items = deriveTaskbar(
      Array.from(this.wins.values()).map((w) => ({
        id: w.id, title: w.opts.title, icon: w.opts.icon,
        active: w.id === this.activeId, minimized: w.minimized,
      })),
    );
    this.changeCbs.forEach((cb) => cb(items));
  }

  openWindow(opts: OpenWindowOptions): WindowHandle {
    const id = `win-${++this.counter}`;
    const width = opts.width ?? 720;
    const height = opts.height ?? 460;
    // 级联初始位置
    const offset = (this.wins.size % 6) * 28;
    const start = clampPosition(
      opts.x ?? 80 + offset, opts.y ?? 60 + offset,
      width, height, window.innerWidth, window.innerHeight,
    );

    const rootEl = document.createElement('div');
    rootEl.className = 'wm-window';
    rootEl.style.cssText =
      `position:absolute;left:${start.x}px;top:${start.y}px;width:${width}px;height:${height}px;` +
      `min-width:${opts.minWidth ?? 320}px;min-height:${opts.minHeight ?? 200}px;` +
      `display:flex;flex-direction:column;background:var(--bg-surface,#12151c);` +
      `border:1px solid var(--border-strong,#2a2f3a);box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;`;

    rootEl.innerHTML = `
      <div class="wm-titlebar" style="height:34px;flex:0 0 auto;display:flex;align-items:center;gap:8px;
           padding:0 8px;background:var(--bg-elevated,#0d1017);cursor:move;user-select:none;">
        <span class="material-symbols-outlined" style="font-size:16px;opacity:.8;">${opts.icon}</span>
        <span class="wm-title" style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escape(opts.title)}</span>
        <button class="wm-min"  title="最小化" style="width:26px;height:24px;">&#8211;</button>
        <button class="wm-max"  title="最大化" style="width:26px;height:24px;">&#9633;</button>
        <button class="wm-close" title="关闭" style="width:26px;height:24px;">&#10005;</button>
      </div>
      <div class="wm-body" style="flex:1;min-height:0;position:relative;overflow:hidden;"></div>
      <div class="wm-resize" style="position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;"></div>
    `;
    this.host.appendChild(rootEl);

    const rec: WinRecord = {
      id, opts, rootEl,
      bodyEl: rootEl.querySelector('.wm-body') as HTMLElement,
      titleEl: rootEl.querySelector('.wm-title') as HTMLElement,
      zIndex: BASE_Z, minimized: false, maximized: false,
      resizeCbs: [], closeCbs: [],
    };
    this.wins.set(id, rec);

    // 聚焦
    rootEl.addEventListener('pointerdown', () => this.focus(id));
    (rootEl.querySelector('.wm-min') as HTMLElement).addEventListener('click', (e) => { e.stopPropagation(); this.minimize(id); });
    (rootEl.querySelector('.wm-max') as HTMLElement).addEventListener('click', (e) => { e.stopPropagation(); this.toggleMaximize(id); });
    (rootEl.querySelector('.wm-close') as HTMLElement).addEventListener('click', (e) => { e.stopPropagation(); this.close(id); });

    this.enableDrag(rec, rootEl.querySelector('.wm-titlebar') as HTMLElement);
    this.enableResize(rec, rootEl.querySelector('.wm-resize') as HTMLElement);

    this.focus(id);
    this.emitChange();
    return this.makeHandle(rec);
  }

  focus(id: string): void {
    const rec = this.wins.get(id);
    if (!rec) return;
    if (rec.minimized) { rec.minimized = false; rec.rootEl.style.display = 'flex'; }
    const zs = Array.from(this.wins.values()).map((w) => w.zIndex);
    rec.zIndex = topZIndex(zs, BASE_Z);
    rec.rootEl.style.zIndex = String(rec.zIndex);
    this.activeId = id;
    this.emitChange();
  }

  minimize(id: string): void {
    const rec = this.wins.get(id);
    if (!rec) return;
    rec.minimized = true;
    rec.rootEl.style.display = 'none';
    if (this.activeId === id) this.activeId = null;
    this.emitChange();
  }

  toggleMaximize(id: string): void {
    const rec = this.wins.get(id);
    if (!rec) return;
    if (!rec.maximized) {
      rec.prevRect = {
        x: rec.rootEl.offsetLeft, y: rec.rootEl.offsetTop,
        width: rec.rootEl.offsetWidth, height: rec.rootEl.offsetHeight,
      };
      rec.rootEl.style.left = '0'; rec.rootEl.style.top = '0';
      rec.rootEl.style.width = '100%';
      rec.rootEl.style.height = `calc(100% - 48px)`; // 预留任务栏
      rec.maximized = true;
    } else if (rec.prevRect) {
      rec.rootEl.style.left = `${rec.prevRect.x}px`;
      rec.rootEl.style.top = `${rec.prevRect.y}px`;
      rec.rootEl.style.width = `${rec.prevRect.width}px`;
      rec.rootEl.style.height = `${rec.prevRect.height}px`;
      rec.maximized = false;
    }
    this.fireResize(rec);
  }

  close(id: string): void {
    const rec = this.wins.get(id);
    if (!rec) return;
    rec.closeCbs.forEach((cb) => cb());
    rec.rootEl.remove();
    this.wins.delete(id);
    if (this.activeId === id) this.activeId = null;
    this.emitChange();
  }

  private enableDrag(rec: WinRecord, handle: HTMLElement): void {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (rec.maximized) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      ox = rec.rootEl.offsetLeft; oy = rec.rootEl.offsetTop;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = clampPosition(
        ox + (e.clientX - sx), oy + (e.clientY - sy),
        rec.rootEl.offsetWidth, rec.rootEl.offsetHeight,
        window.innerWidth, window.innerHeight,
      );
      rec.rootEl.style.left = `${p.x}px`;
      rec.rootEl.style.top = `${p.y}px`;
    });
    handle.addEventListener('pointerup', (e) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }

  private enableResize(rec: WinRecord, handle: HTMLElement): void {
    let sx = 0, sy = 0, ow = 0, oh = 0, resizing = false;
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); resizing = true;
      sx = e.clientX; sy = e.clientY;
      ow = rec.rootEl.offsetWidth; oh = rec.rootEl.offsetHeight;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const minW = rec.opts.minWidth ?? 320;
      const minH = rec.opts.minHeight ?? 200;
      rec.rootEl.style.width = `${Math.max(minW, ow + (e.clientX - sx))}px`;
      rec.rootEl.style.height = `${Math.max(minH, oh + (e.clientY - sy))}px`;
      this.fireResize(rec);
    });
    handle.addEventListener('pointerup', (e) => {
      resizing = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.fireResize(rec);
    });
  }

  private fireResize(rec: WinRecord): void {
    rec.resizeCbs.forEach((cb) => cb());
  }

  private makeHandle(rec: WinRecord): WindowHandle {
    return {
      id: rec.id,
      bodyEl: rec.bodyEl,
      focus: () => this.focus(rec.id),
      minimize: () => this.minimize(rec.id),
      toggleMaximize: () => this.toggleMaximize(rec.id),
      close: () => this.close(rec.id),
      setTitle: (t: string) => { rec.opts.title = t; rec.titleEl.textContent = t; this.emitChange(); },
      setDisconnected: (d: boolean) => { rec.rootEl.classList.toggle('wm-disconnected', d); },
      onResize: (cb: () => void) => { rec.resizeCbs.push(cb); },
      onClose: (cb: () => void) => { rec.closeCbs.push(cb); },
    };
  }

  private escape(s: string): string {
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
}
