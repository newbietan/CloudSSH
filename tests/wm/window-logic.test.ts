import { describe, it, expect } from 'vitest';
import { clampPosition, topZIndex, deriveTaskbar } from '../../frontend/src/wm/window-logic';

describe('clampPosition', () => {
  it('右下越界被钳制到可视范围', () => {
    // 视口 1000x800，任务栏 48 → 可用高 752；窗口 400x300 → maxX=600, maxY=452
    expect(clampPosition(2000, 2000, 400, 300, 1000, 800, 48)).toEqual({ x: 600, y: 452 });
  });
  it('负坐标钳制到 0', () => {
    expect(clampPosition(-50, -20, 400, 300, 1000, 800, 48)).toEqual({ x: 0, y: 0 });
  });
  it('窗口比视口大时回到原点', () => {
    expect(clampPosition(100, 100, 2000, 2000, 1000, 800, 48)).toEqual({ x: 0, y: 0 });
  });
});

describe('topZIndex', () => {
  it('空集合返回 base', () => {
    expect(topZIndex([], 100)).toBe(100);
  });
  it('返回当前最大值 +1', () => {
    expect(topZIndex([100, 103, 101], 100)).toBe(104);
  });
});

describe('deriveTaskbar', () => {
  it('按打开顺序映射窗口元数据', () => {
    const items = deriveTaskbar([
      { id: 'a', title: 'A', icon: 'terminal', active: false, minimized: false },
      { id: 'b', title: 'B', icon: 'folder', active: true, minimized: true },
    ]);
    expect(items).toEqual([
      { id: 'a', title: 'A', icon: 'terminal', active: false, minimized: false },
      { id: 'b', title: 'B', icon: 'folder', active: true, minimized: true },
    ]);
  });
});
