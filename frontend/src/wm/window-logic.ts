// 窗口纯逻辑：不依赖 DOM，便于单元测试

/** 将窗口左上角坐标钳制在视口内，底部预留任务栏高度，保证整窗可见 */
export function clampPosition(
  x: number, y: number, width: number, height: number,
  viewportWidth: number, viewportHeight: number, taskbarHeight = 48,
): { x: number; y: number } {
  const maxX = Math.max(0, viewportWidth - width);
  const maxY = Math.max(0, (viewportHeight - taskbarHeight) - height);
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

/** 聚焦某窗口时应使用的新 z-index（当前最大值 +1；空集合用 base） */
export function topZIndex(zIndexes: number[], base = 100): number {
  if (zIndexes.length === 0) return base;
  return Math.max(...zIndexes) + 1;
}

export interface WindowMeta {
  id: string; title: string; icon: string; active: boolean; minimized: boolean;
}
export type TaskbarItem = WindowMeta;

/** 由窗口集合派生任务栏项（保持传入顺序） */
export function deriveTaskbar(windows: WindowMeta[]): TaskbarItem[] {
  return windows.map((w) => ({
    id: w.id, title: w.title, icon: w.icon, active: w.active, minimized: w.minimized,
  }));
}
