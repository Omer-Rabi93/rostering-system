import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';

import { cellKey, isNavKey, neighborFor, useRovingTabindex } from './rovingTabindex.js';

describe('isNavKey', () => {
  it('recognizes the six nav keys and rejects everything else', () => {
    expect(isNavKey('ArrowRight')).toBe(true);
    expect(isNavKey('ArrowLeft')).toBe(true);
    expect(isNavKey('ArrowUp')).toBe(true);
    expect(isNavKey('ArrowDown')).toBe(true);
    expect(isNavKey('Home')).toBe(true);
    expect(isNavKey('End')).toBe(true);
    expect(isNavKey('Enter')).toBe(false);
    expect(isNavKey('a')).toBe(false);
    expect(isNavKey(' ')).toBe(false);
  });
});

describe('cellKey', () => {
  it('builds a stable composite key from row/col', () => {
    expect(cellKey(0, 0)).toBe('0|0');
    expect(cellKey(2, 5)).toBe('2|5');
  });
});

describe('neighborFor', () => {
  const DIMS = { numRows: 3, numCols: 4 };

  it('moves right within a row', () => {
    expect(neighborFor('ArrowRight', { row: 1, col: 1 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 1, col: 2 });
  });

  it('wraps ArrowRight from the last column to the first column of the next row', () => {
    expect(neighborFor('ArrowRight', { row: 0, col: 3 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 1, col: 0 });
  });

  it('returns null on ArrowRight from the very last cell', () => {
    expect(neighborFor('ArrowRight', { row: 2, col: 3 }, DIMS.numRows, DIMS.numCols)).toBeNull();
  });

  it('moves left within a row', () => {
    expect(neighborFor('ArrowLeft', { row: 1, col: 2 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 1, col: 1 });
  });

  it('wraps ArrowLeft from the first column to the last column of the previous row', () => {
    expect(neighborFor('ArrowLeft', { row: 1, col: 0 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 0, col: 3 });
  });

  it('returns null on ArrowLeft from the very first cell', () => {
    expect(neighborFor('ArrowLeft', { row: 0, col: 0 }, DIMS.numRows, DIMS.numCols)).toBeNull();
  });

  it('moves down without wrapping, and returns null at the last row', () => {
    expect(neighborFor('ArrowDown', { row: 0, col: 2 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 1, col: 2 });
    expect(neighborFor('ArrowDown', { row: 2, col: 2 }, DIMS.numRows, DIMS.numCols)).toBeNull();
  });

  it('moves up without wrapping, and returns null at the first row', () => {
    expect(neighborFor('ArrowUp', { row: 2, col: 2 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 1, col: 2 });
    expect(neighborFor('ArrowUp', { row: 0, col: 2 }, DIMS.numRows, DIMS.numCols)).toBeNull();
  });

  it('Home jumps to the first column of the same row', () => {
    expect(neighborFor('Home', { row: 1, col: 3 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 1, col: 0 });
  });

  it('End jumps to the last column of the same row', () => {
    expect(neighborFor('End', { row: 1, col: 0 }, DIMS.numRows, DIMS.numCols)).toEqual({ row: 1, col: 3 });
  });
});

describe('useRovingTabindex', () => {
  function makeCellEl(): HTMLElement {
    const el = document.createElement('td');
    // jsdom (like a real browser) only makes an element focus()-able if it has a tabindex
    // attribute — every real cell in CalendarGrid/AvailabilityGrid always sets one (0 or -1), so
    // this mirrors that rather than being test-only scaffolding.
    el.tabIndex = -1;
    document.body.appendChild(el);
    return el;
  }

  it('defaults uncontrolled focus to (0,0) and reports isFocused correctly', () => {
    const { result } = renderHook(() => useRovingTabindex({ numRows: 3, numCols: 3 }));
    expect(result.current.focusedPos).toEqual({ row: 0, col: 0 });
    expect(result.current.isFocused(0, 0)).toBe(true);
    expect(result.current.isFocused(1, 1)).toBe(false);
  });

  it('moves DOM focus and internal state via focusCell, notifying onFocusChange', () => {
    const onFocusChange = vi.fn();
    const { result } = renderHook(() => useRovingTabindex({ numRows: 3, numCols: 3, onFocusChange }));

    const cell = makeCellEl();
    act(() => result.current.registerCellRef(1, 2, cell));
    act(() => result.current.focusCell(1, 2));

    expect(document.activeElement).toBe(cell);
    expect(onFocusChange).toHaveBeenCalledWith({ row: 1, col: 2 });
    expect(result.current.focusedPos).toEqual({ row: 1, col: 2 });
  });

  it('handleNavKeyDown moves focus to the neighbor and returns true when a neighbor exists', () => {
    const { result } = renderHook(() => useRovingTabindex({ numRows: 2, numCols: 2 }));
    const target = makeCellEl();
    act(() => result.current.registerCellRef(0, 1, target));

    const preventDefault = vi.fn();
    const event = { key: 'ArrowRight', preventDefault } as unknown as KeyboardEvent<HTMLElement>;

    let handled = false;
    act(() => {
      handled = result.current.handleNavKeyDown(event, 0, 0);
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(target);
  });

  it('handleNavKeyDown returns false and does not preventDefault for a non-nav key', () => {
    const { result } = renderHook(() => useRovingTabindex({ numRows: 2, numCols: 2 }));
    const preventDefault = vi.fn();
    const event = { key: 'a', preventDefault } as unknown as KeyboardEvent<HTMLElement>;

    let handled = true;
    act(() => {
      handled = result.current.handleNavKeyDown(event, 0, 0);
    });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('handleNavKeyDown returns false when the nav key has no valid neighbor', () => {
    const { result } = renderHook(() => useRovingTabindex({ numRows: 1, numCols: 1 }));
    const preventDefault = vi.fn();
    const event = { key: 'ArrowDown', preventDefault } as unknown as KeyboardEvent<HTMLElement>;

    let handled = true;
    act(() => {
      handled = result.current.handleNavKeyDown(event, 0, 0);
    });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('respects a controlled focusedPos: internal DOM focus moves but the reported focusedPos does not until the prop updates', () => {
    const onFocusChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ focusedPos }) => useRovingTabindex({ numRows: 2, numCols: 2, focusedPos, onFocusChange }),
      { initialProps: { focusedPos: { row: 0, col: 0 } } },
    );

    const cellB = makeCellEl();
    act(() => result.current.registerCellRef(0, 1, cellB));
    act(() => result.current.focusCell(0, 1));

    expect(document.activeElement).toBe(cellB);
    expect(onFocusChange).toHaveBeenCalledWith({ row: 0, col: 1 });
    // Controlled: focusedPos bookkeeping is still driven by the (unchanged) prop.
    expect(result.current.focusedPos).toEqual({ row: 0, col: 0 });

    rerender({ focusedPos: { row: 0, col: 1 } });
    expect(result.current.focusedPos).toEqual({ row: 0, col: 1 });
  });
});
