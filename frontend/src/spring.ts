/**
 * 一维物理弹簧引擎（Shared Spring Physics）
 * 刚度/阻尼/质量 + rAF 积分，供液态分段切换器与各类微交互复用。
 */

export class Spring {
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

  /** 立即停靠到指定位置并清空速度 */
  public snapTo(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
}

/** Slight edge lag retains a hint of stretch without sending the lens past its target. */
export function tuneSegmentedSprings(leading: Spring, trailing: Spring): void {
  leading.stiffness = 360;
  leading.damping = 38;
  trailing.stiffness = 300;
  trailing.damping = 35;
}
