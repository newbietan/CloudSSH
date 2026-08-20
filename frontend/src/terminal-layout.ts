export function resolveTerminalFontSize(viewportWidth: number, coarsePointer: boolean): number {
  if (viewportWidth < 768) return 12;
  if (viewportWidth <= 1180 && coarsePointer) return 13;
  return 14;
}

export function currentTerminalFontSize(): number {
  return resolveTerminalFontSize(window.innerWidth, window.matchMedia('(pointer: coarse)').matches);
}
