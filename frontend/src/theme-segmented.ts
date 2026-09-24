/**
 * Apple macOS 26 / iOS 26 液态分段主题切换器（Liquid Segmented Theme Control）
 * 采用双边异步物理弹簧（Asymmetric Dual-Edge Springs）驱动：
 * - 领先边：高刚度高阻尼，快速到位不震荡
 * - 拖后边：低刚度低阻尼，滞后追赶，途中产生真实的流体拉伸形变（Fluid Stretch）
 * - 目标到达后自动切断 rAF 循环，零静止 CPU 消耗。
 */

class Spring {
  public value: number;
  public target: number;
  public velocity: number = 0;
  public stiffness: number;
  public damping: number;
  public mass: number;

  constructor(value: number, stiffness = 170, damping = 20, mass = 1) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }

  public update(dt: number): void {
    const force = -this.stiffness * (this.value - this.target);
    const damp = -this.damping * this.velocity;
    const accel = (force + damp) / this.mass;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
  }

  public settled(eps = 0.1): boolean {
    return Math.abs(this.value - this.target) < eps && Math.abs(this.velocity) < eps;
  }
}

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

  // 双边异步物理弹簧引擎
  private leftSpring = new Spring(0, 210, 24);
  private rightSpring = new Spring(0, 210, 24);
  private lastCenter: number | null = null;
  private animFrameId: number | null = null;
  private lastTimestamp: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

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

  /** 动态更新透镜位置与双边异步弹簧动效 */
  private updateLensPosition(animate = true): void {
    const activeBtn = this.buttons.get(this.currentTheme);
    if (!activeBtn) {
      this.lens.style.opacity = '0';
      return;
    }

    if (activeBtn.offsetWidth === 0 || this.container.offsetWidth === 0) {
      // 容器尚未渲染可见（如在隐藏面板中）
      return;
    }

    const left = activeBtn.offsetLeft;
    const right = left + activeBtn.offsetWidth;
    const center = (left + right) / 2;
    const movingRight = this.lastCenter === null ? true : center > this.lastCenter;
    this.lastCenter = center;

    const reduceMotion =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

    if (!animate || reduceMotion || this.leftSpring.value === 0) {
      // 即时停靠（首次加载或无障碍）
      this.leftSpring.value = left;
      this.leftSpring.target = left;
      this.leftSpring.velocity = 0;
      this.rightSpring.value = right;
      this.rightSpring.target = right;
      this.rightSpring.velocity = 0;
      this.renderPill(left, right);
      this.lens.style.opacity = '1';
      return;
    }

    // 双边异步参数调优：
    // 领先边：刚度 260、阻尼 26 → 迅捷前驱不抖动
    // 拖后边：刚度 130、阻尼 15 → 弹性迟滞，产生自然流体微拉伸
    if (movingRight) {
      this.rightSpring.stiffness = 260;
      this.rightSpring.damping = 26;
      this.leftSpring.stiffness = 130;
      this.leftSpring.damping = 15;
    } else {
      this.leftSpring.stiffness = 260;
      this.leftSpring.damping = 26;
      this.rightSpring.stiffness = 130;
      this.rightSpring.damping = 15;
    }

    this.leftSpring.target = left;
    this.rightSpring.target = right;
    this.lens.style.opacity = '1';

    this.startAnimationLoop();
  }

  private startAnimationLoop(): void {
    if (this.animFrameId !== null) return;
    this.lastTimestamp = performance.now();

    const loop = (now: number): void => {
      const dt = this.lastTimestamp ? Math.min((now - this.lastTimestamp) / 1000, 0.032) : 0.016;
      this.lastTimestamp = now;

      this.leftSpring.update(dt);
      this.rightSpring.update(dt);

      this.renderPill(this.leftSpring.value, this.rightSpring.value);

      if (this.leftSpring.settled() && this.rightSpring.settled()) {
        // 到达目标，停稳退出循环（0 空转消耗！）
        this.renderPill(this.leftSpring.target, this.rightSpring.target);
        this.animFrameId = null;
        this.lastTimestamp = null;
        return;
      }

      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  private renderPill(l: number, r: number): void {
    const width = Math.max(0, r - l);
    this.lens.style.width = `${width}px`;
    this.lens.style.transform = `translateX(${l}px)`;
  }

  /** 强制重新校准透镜位置（如容器从 hidden 恢复可见时） */
  public refresh(): void {
    this.updateLensPosition(false);
  }

  /** 确保自定义主题项存在 */
  public ensureCustomButton(): void {
    if (this.buttons.has('__custom__')) return;

    const btn = this.createButton('__custom__', 'Custom', 'palette');
    this.buttons.set('__custom__', btn);
    this.container.appendChild(btn);
    this.updateLensPosition(false);
  }

  /** 移除自定义主题项（登录态回归内置并清除云端主题槽时，与 select option 同步移除） */
  public removeCustomButton(): void {
    const btn = this.buttons.get('__custom__');
    if (!btn) return;
    btn.remove();
    this.buttons.delete('__custom__');
    if (this.currentTheme === '__custom__') {
      // 选中项被移除时透镜退化为不可见，由调用方随后 syncFromSelect 修正
      this.currentTheme = '';
    }
    this.updateLensPosition(false);
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }
}
