export interface SelectionOptions {
  additive: boolean;
  range: boolean;
}

export interface SelectionResult {
  selected: Set<number>;
  anchor: number;
}

export function updateSelection(
  current: ReadonlySet<number>,
  clickedIndex: number,
  anchorIndex: number | null,
  itemCount: number,
  options: SelectionOptions,
): SelectionResult {
  const clicked = Math.min(Math.max(0, clickedIndex), Math.max(0, itemCount - 1));
  const selected = options.additive ? new Set(current) : new Set<number>();

  if (options.range && anchorIndex !== null) {
    const start = Math.min(anchorIndex, clicked);
    const end = Math.max(anchorIndex, clicked);
    for (let index = start; index <= end; index++) selected.add(index);
  } else if (options.additive && selected.has(clicked)) {
    selected.delete(clicked);
  } else {
    selected.add(clicked);
  }

  return { selected, anchor: clicked };
}
