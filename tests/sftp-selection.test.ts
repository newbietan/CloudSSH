import { describe, expect, it } from 'vitest';
import { updateSelection } from '../frontend/src/sftp-selection';

describe('SFTP multi selection', () => {
  it('replaces the selection on a plain click', () => {
    const result = updateSelection(new Set([1, 2]), 4, 2, 10, {
      additive: false,
      range: false,
    });
    expect([...result.selected]).toEqual([4]);
    expect(result.anchor).toBe(4);
  });

  it('toggles items with Ctrl/Cmd', () => {
    expect([...updateSelection(new Set([1, 2]), 2, 1, 10, {
      additive: true,
      range: false,
    }).selected]).toEqual([1]);
    expect([...updateSelection(new Set([1]), 3, 1, 10, {
      additive: true,
      range: false,
    }).selected]).toEqual([1, 3]);
  });

  it('selects a contiguous range with Shift', () => {
    expect([...updateSelection(new Set([2]), 5, 2, 10, {
      additive: false,
      range: true,
    }).selected]).toEqual([2, 3, 4, 5]);
  });
});
