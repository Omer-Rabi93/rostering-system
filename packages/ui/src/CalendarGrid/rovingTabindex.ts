import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

/**
 * Shared roving-tabindex focus math, extracted from `CalendarGrid` (Availability v2, Phase V5) so
 * `AvailabilityGrid` (workers x dates) can reuse the exact same keyboard-nav implementation
 * instead of forking a ~90-line copy. The hook is deliberately ignorant of what a "row"/"col"
 * *means* to its caller (shift type vs. worker, day vs. date) — it only tracks integer grid
 * coordinates, ref registration, and Arrow/Home/End math; callers map row/col indices to their own
 * domain values (date/shift, workerId/date) and handle Enter/Space/letter-key activation
 * themselves via `onKeyDown`, since that behavior differs per grid.
 */

export type GridPos = { row: number; col: number };

const NAV_KEYS = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const;
export type NavKey = (typeof NAV_KEYS)[number];

export function isNavKey(key: string): key is NavKey {
  return (NAV_KEYS as readonly string[]).includes(key);
}

/**
 * Computes the roving-tabindex neighbor for a nav key, given the focused cell's (row, col) and
 * the grid's dimensions. Mirrors `initRovingGrid` in docs/design/ui/kit.js: ArrowRight/ArrowLeft
 * wrap to the next/previous row when they run off the end of a row; ArrowUp/ArrowDown/Home/End
 * don't wrap off the grid (they return null when there's no valid neighbor).
 */
export function neighborFor(key: NavKey, pos: GridPos, numRows: number, numCols: number): GridPos | null {
  const { row, col } = pos;
  switch (key) {
    case 'ArrowRight':
      if (col + 1 < numCols) return { row, col: col + 1 };
      if (row + 1 < numRows) return { row: row + 1, col: 0 };
      return null;
    case 'ArrowLeft':
      if (col - 1 >= 0) return { row, col: col - 1 };
      if (row - 1 >= 0) return { row: row - 1, col: numCols - 1 };
      return null;
    case 'ArrowDown':
      return row + 1 < numRows ? { row: row + 1, col } : null;
    case 'ArrowUp':
      return row - 1 >= 0 ? { row: row - 1, col } : null;
    case 'Home':
      return { row, col: 0 };
    case 'End':
      return { row, col: numCols - 1 };
    default:
      return null;
  }
}

export function cellKey(row: number, col: number): string {
  return `${row}|${col}`;
}

export interface UseRovingTabindexOptions {
  readonly numRows: number;
  readonly numCols: number;
  /** Controlled focus position (e.g. lifted into a Redux slice); when omitted the hook manages its
   * own focus position (uncontrolled), mirroring `CalendarGrid`'s prior `focusedSlot`/`onFocusSlot`
   * contract — the caller must feed the result back in via `focusedPos` the same way a controlled
   * `<input value>` works. */
  readonly focusedPos?: GridPos;
  /** Notified whenever the roving-focused cell changes, whether from a click, an arrow-key/Home/End
   * move, or a caller-driven `focusCell` call — regardless of whether `focusedPos` is controlled. */
  readonly onFocusChange?: (pos: GridPos) => void;
  /** Starting position when uncontrolled and no prior focus exists. Defaults to `{row:0, col:0}`. */
  readonly initialPos?: GridPos;
}

export interface UseRovingTabindexResult {
  readonly focusedPos: GridPos;
  readonly isFocused: (row: number, col: number) => boolean;
  readonly registerCellRef: (row: number, col: number, el: HTMLElement | null) => void;
  readonly focusCell: (row: number, col: number) => void;
  /** Handles Arrow/Home/End on a cell's `onKeyDown`: moves DOM focus + roving state and calls
   * `event.preventDefault()` when the key resolves to a real neighbor; returns `true` in that case
   * so the caller knows the key was consumed, `false` for any other key (including a nav key with
   * no valid neighbor) so the caller can still run its own handling (Enter/Space/letter keys). */
  readonly handleNavKeyDown: (event: KeyboardEvent<HTMLElement>, row: number, col: number) => boolean;
}

export function useRovingTabindex(options: UseRovingTabindexOptions): UseRovingTabindexResult {
  const { numRows, numCols, focusedPos, onFocusChange, initialPos } = options;
  const isControlled = focusedPos !== undefined;
  const [internalFocus, setInternalFocus] = useState<GridPos>(
    () => focusedPos ?? initialPos ?? { row: 0, col: 0 },
  );
  const focused = isControlled ? focusedPos : internalFocus;

  const cellRefs = useRef(new Map<string, HTMLElement>());

  // Every returned function is wrapped in `useCallback` with the narrowest dependency list it
  // actually needs, so its identity is stable across re-renders unless something it genuinely
  // depends on changed. `CalendarGrid` doesn't rely on this (it re-derives everything per render
  // regardless), but `AvailabilityGrid` passes these straight down as props to a `React.memo`'d
  // per-cell component over a potentially large worker x date grid — a fresh function identity on
  // every keystroke would defeat that memoization and re-render the whole grid every time.
  const registerCellRef = useCallback((row: number, col: number, el: HTMLElement | null) => {
    const key = cellKey(row, col);
    if (el) {
      cellRefs.current.set(key, el);
    } else {
      cellRefs.current.delete(key);
    }
  }, []);

  const notifyFocus = useCallback(
    (row: number, col: number) => {
      if (!isControlled) setInternalFocus({ row, col });
      onFocusChange?.({ row, col });
    },
    [isControlled, onFocusChange],
  );

  const focusCell = useCallback(
    (row: number, col: number) => {
      cellRefs.current.get(cellKey(row, col))?.focus();
      notifyFocus(row, col);
    },
    [notifyFocus],
  );

  const handleNavKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, row: number, col: number): boolean => {
      if (!isNavKey(event.key)) return false;
      const next = neighborFor(event.key, { row, col }, numRows, numCols);
      if (!next) return false;
      event.preventDefault();
      focusCell(next.row, next.col);
      return true;
    },
    [numRows, numCols, focusCell],
  );

  const isFocused = useCallback(
    (row: number, col: number) => focused.row === row && focused.col === col,
    [focused],
  );

  return {
    focusedPos: focused,
    isFocused,
    registerCellRef,
    focusCell,
    handleNavKeyDown,
  };
}
