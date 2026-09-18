/**
 * Apple macOS 26 抽屉式功能模块分段切换器（Liquid Segmented Drawer Control）
 * 将 SFTP 文件管理、Command Snippets 自定义命令与 AI Agent 整合为分段药丸胶囊，
 * 配备双边异步物理弹簧（Asymmetric Dual-Edge Springs）驱动的液态透镜滑块。
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

export class LiquidSegmentedDrawerControl {
  private readonly container: HTMLElement;
  private readonly lens: HTMLElement;
  private readonly buttons: Map<string, HTMLButtonElement> = new Map();
  private activeDrawer: string | null = null;
  private onToggleCallback?: (drawer: string, open: boolean) => void;

  // 双边异步物理弹簧引擎
  private leftSpring = new Spring(0, 210, 24);
  private rightSpring = new Spring(0, 210, 24);
  private lastCenter: number | null = null;
  private animFrameId: number | null = null;
  private lastTimestamp: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    onToggle?: (drawer: string, open: boolean) => void
  ) {
    this.container = container;
    this.lens = container.querySelector('.drawer-segmented-lens') as HTMLElement;
    this.onToggleCallback = onToggle;

    const btnElements = container.querySelectorAll<HTMLButtonElement>('.drawer-segmented-btn');
    for (const btn of btnElements) {
      const drawer = btn.getAttribute('data-drawer');
      if (drawer) {
        this.buttons.set(drawer, btn);
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.handleButtonClick(drawer);
        });
      }
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.activeDrawer) {
          this.updateLensPosition(false);
        }
      });
      this.resizeObserver.observe(this.container);
    }
  }

  private handleButtonClick(drawer: string): void {
    if (this.activeDrawer === drawer) {
      // 再次点击同一个激活按钮：收起抽屉
      this.setActive(null, true);
      this.onToggleCallback?.(drawer, false);
    } else {
      // 切换到新抽屉：透镜丝滑滑移过去
      this.setActive(drawer, true);
      this.onToggleCallback?.(drawer, true);
    }
  }

  public setActive(drawer: string | null, animate = true): void {
    const prevDrawer = this.activeDrawer;
    this.activeDrawer = drawer;

    for (const [id, btn] of this.buttons.entries()) {
      const isSelected = id === drawer;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.classList.toggle('active', isSelected);
    }

    if (!drawer) {
      this.stopAnimationLoop();
      this.lens.style.opacity = '0';
      this.lastCenter = null;
      return;
    }

    this.updateLensPosition(animate && prevDrawer !== null);
  }

  public getActive(): string | null {
    return this.activeDrawer;
  }

  private updateLensPosition(animate = true): void {
    if (!this.activeDrawer) return;

    const activeBtn = this.buttons.get(this.activeDrawer);
    if (!activeBtn) return;

    const segRect = this.container.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();

    if (btnRect.width === 0 || segRect.width === 0) {
      return;
    }

    const left = btnRect.left - segRect.left;
    const right = btnRect.right - segRect.left;
    const center = (left + right) / 2;
    const movingRight = this.lastCenter === null ? true : center > this.lastCenter;
    this.lastCenter = center;

    const reduceMotion =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

    if (!animate || reduceMotion || this.lastCenter === null) {
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

    // 双边异步参数：领先边刚度 260/阻尼 26，拖后边刚度 130/阻尼 15
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
        this.renderPill(this.leftSpring.target, this.rightSpring.target);
        this.animFrameId = null;
        this.lastTimestamp = null;
        return;
      }

      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  private stopAnimationLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private renderPill(l: number, r: number): void {
    const width = Math.max(0, r - l);
    this.lens.style.width = `${width}px`;
    this.lens.style.transform = `translateX(${l}px)`;
  }

  public refresh(): void {
    if (this.activeDrawer) {
      this.updateLensPosition(false);
    }
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.stopAnimationLoop();
  }
}
