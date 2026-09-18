/**
 * Apple macOS 26 / iOS 26 液态分段主题切换器（Liquid Segmented Theme Control）
 * 具有晶莹剔透的 3D 液态玻璃透镜滑块（Liquid Lens Indicator），
 * 支持流体拉伸形变与弹性过冲回弹（Spring Physics），与底层 select 保持双向同步。
 */

const THEME_OPTIONS = [
  { id: 'standard-dark', label: 'Dark', icon: 'dark_mode' },
  { id: 'standard-light', label: 'Light', icon: 'light_mode' },
  { id: 'cyberpunk', label: 'Cyber', icon: 'bolt' },
  { id: 'liquid-glass', label: 'Liquid', icon: 'water_drop' },
];

export class LiquidSegmentedThemeControl {
  private readonly container: HTMLElement;
  private readonly lens: HTMLElement;
  private readonly select: HTMLSelectElement;
  private buttons: Map<string, HTMLButtonElement> = new Map();
  private currentTheme: string = 'liquid-glass';
  private resizeObserver: ResizeObserver | null = null;
  private slideTimeout: number | null = null;

  constructor(container: HTMLElement, select: HTMLSelectElement) {
    this.container = container;
    this.select = select;

    this.container.classList.add('theme-segmented-bar');
    this.container.setAttribute('role', 'tablist');
    this.container.setAttribute('aria-label', '主题与界面风格');

    // 创建滑动的 3D 液态玻璃透镜
    this.lens = document.createElement('div');
    this.lens.className = 'theme-segmented-lens';
    this.container.appendChild(this.lens);

    // 构建分段按钮
    for (const opt of THEME_OPTIONS) {
      const btn = this.createButton(opt.id, opt.label, opt.icon);
      this.buttons.set(opt.id, btn);
      this.container.appendChild(btn);
    }

    // 初始化选中的主题
    const initialVal = select.value || 'liquid-glass';
    this.syncFromSelect(initialVal, false);

    // 监听 select 变更（双向绑定）
    select.addEventListener('change', () => {
      this.syncFromSelect(select.value, true);
    });

    // 监听视口或容器尺寸变化以动态校准透镜位置
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateLensPosition(false);
      });
      this.resizeObserver.observe(this.container);
    }

    // 延时在下一帧微调校准（确保初始布局就绪）
    requestAnimationFrame(() => {
      this.updateLensPosition(false);
    });
  }

  private createButton(id: string, label: string, icon: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-segmented-btn';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-theme-id', id);
    btn.setAttribute('aria-selected', 'false');
    btn.title = label;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'material-symbols-outlined theme-segmented-icon';
    iconSpan.textContent = icon;
    btn.appendChild(iconSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'theme-segmented-label';
    textSpan.textContent = label;
    btn.appendChild(textSpan);

    btn.addEventListener('click', () => {
      if (this.currentTheme === id) return;
      this.selectTheme(id);
    });

    return btn;
  }

  /** 点击分段选项时派发同步 */
  public selectTheme(id: string): void {
    if (this.select.value !== id) {
      this.select.value = id;
      this.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.syncFromSelect(id, true);
  }

  /** 从 select 状态同步到分段控制条 */
  public syncFromSelect(value: string, animate = true): void {
    if (value === '__custom__') {
      this.ensureCustomButton();
    }

    this.currentTheme = value;

    for (const [id, btn] of this.buttons.entries()) {
      const isSelected = id === value;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.classList.toggle('active', isSelected);
    }

    this.updateLensPosition(animate);
  }

  /** 动态更新透镜位置与流体拉伸动效 */
  private updateLensPosition(animate = true): void {
    const activeBtn = this.buttons.get(this.currentTheme);
    if (!activeBtn) {
      this.lens.style.opacity = '0';
      return;
    }

    const containerRect = this.container.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();

    if (btnRect.width === 0 || containerRect.width === 0) {
      // 容器尚未渲染可见（如在隐藏面板中）
      return;
    }

    const targetLeft = activeBtn.offsetLeft;
    const targetWidth = activeBtn.offsetWidth;

    const currentLeft = parseFloat(this.lens.style.left || '0');
    const isMoving = animate && !Number.isNaN(currentLeft) && currentLeft !== 0 && currentLeft !== targetLeft;

    if (isMoving) {
      // 还原 GIF：滑行途中赋予微流体水平拉伸与轻度扁平
      this.lens.classList.add('is-sliding');
      if (this.slideTimeout !== null) {
        clearTimeout(this.slideTimeout);
      }
      this.slideTimeout = window.setTimeout(() => {
        this.lens.classList.remove('is-sliding');
        this.slideTimeout = null;
      }, 420);
    }

    this.lens.style.opacity = '1';
    this.lens.style.left = `${targetLeft}px`;
    this.lens.style.width = `${targetWidth}px`;
  }

  /** 确保自定义主题项存在 */
  public ensureCustomButton(): void {
    if (this.buttons.has('__custom__')) return;

    const btn = this.createButton('__custom__', 'Custom', 'palette');
    this.buttons.set('__custom__', btn);
    this.container.appendChild(btn);
    this.updateLensPosition(false);
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.slideTimeout !== null) {
      clearTimeout(this.slideTimeout);
      this.slideTimeout = null;
    }
  }
}
