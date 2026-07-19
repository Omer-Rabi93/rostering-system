import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { isNavKey, neighborFor, useRovingTabindex, type GridPos } from '@rostering/ui';
import { SHIFT_TYPES } from '@rostering/shared';
import type { Month, ShiftType } from '@rostering/shared';

import { useListWorkersQuery } from '../../api/workers.api.js';
import { useGetMonthAvailabilityQuery, useReplaceMonthAvailabilityMutation } from '../../api/availability.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { buildMonthDays } from '../../lib/calendar.js';
import {
  cellShifts,
  clearWorkerRow,
  draftFromMonthAvailability,
  draftToPayload,
  setAllDatesForWorker,
  toggleCell,
  type AvailabilityDraft,
} from './availabilityDraft.js';

export interface AvailabilityGridProps {
  readonly month: Month;
  /** v4: both the `GET`/`PUT /api/availability/:month` reads/save require a `companyId` (see
   * `apps/api/src/routes/availability.ts`'s `companyIdQuerySchema`) -- used to scope the worker
   * list, the availability read, and the save, threaded from `RosterPage` (which already reads it
   * via `useActiveCompanyId()`) rather than re-reading the context here. */
  readonly companyId: number;
}

/**
 * Availability v3: `shifts` here is the EXCLUDED-shift subset (the grid matches the CSV/DB 1:1 —
 * "Option A" in `.notes/availability-v3-exclusion-semantics-and-combined-csv-plan.md`'s Part F —
 * toggling a letter marks yourself excluded from that shift, not included in it). An empty subset
 * (no row for this worker/date) means available for every shift; a full 3-letter subset means
 * unavailable the entire date; anything in between names exactly the shift(s) the worker is NOT
 * available for that date.
 */
function buildCellAriaLabel(workerName: string, dayLabel: string, shifts: readonly ShiftType[]): string {
  const subsetText =
    shifts.length === 0
      ? 'available for all shifts'
      : shifts.length === SHIFT_TYPES.length
        ? 'unavailable'
        : `unavailable for shift ${shifts.join(', ')}`;
  return `${workerName}, ${dayLabel}, ${subsetText}`;
}

interface AvailabilityCellProps {
  readonly row: number;
  readonly col: number;
  readonly workerId: number;
  readonly workerName: string;
  readonly date: string;
  readonly dayLabel: string;
  readonly isWeekend: boolean;
  readonly shifts: readonly ShiftType[];
  readonly isFocused: boolean;
  readonly registerCellRef: (row: number, col: number, el: HTMLElement | null) => void;
  readonly onCellKeyDown: (
    event: KeyboardEvent<HTMLTableCellElement>,
    workerId: number,
    date: string,
    row: number,
    col: number,
  ) => void;
  readonly onCellClick: (
    event: MouseEvent<HTMLTableCellElement>,
    workerId: number,
    date: string,
    row: number,
    col: number,
  ) => void;
}

/**
 * One worker x date cell — memoized so toggling a single cell only re-renders that cell, not the
 * whole (potentially 50-150 workers x 31 dates) grid. For that to actually work, every prop here
 * must be a primitive or a referentially-stable value: `shifts` is either the shared empty-array
 * constant or an array `toggleCell` only replaces for the exact cell that changed (see
 * `availabilityDraft.ts`), and `registerCellRef`/`onCellKeyDown`/`onCellClick` are `useCallback`'d
 * in the parent with no per-render-changing dependencies.
 *
 * a11y: the `<td>` itself is the single roving tab stop (`role="gridcell"`, one tab stop per
 * cell, mirroring `CalendarGrid`) — there are no nested checkboxes/buttons that would add extra
 * stops. The three shift letters are decorative visual targets (clickable for mouse convenience
 * via event-target delegation) but are not independently focusable. Keyboard: Arrow/Home/End move
 * the roving focus exactly like `CalendarGrid`; pressing `A`/`B`/`C` while the cell is focused
 * toggles that shift directly (no separate "edit mode" — this is the whole interaction).
 */
const AvailabilityCell = memo(function AvailabilityCell(props: AvailabilityCellProps) {
  const {
    row,
    col,
    workerId,
    workerName,
    date,
    dayLabel,
    isWeekend,
    shifts,
    isFocused,
    registerCellRef,
    onCellKeyDown,
    onCellClick,
  } = props;

  return (
    <td
      ref={(el) => registerCellRef(row, col, el)}
      role="gridcell"
      tabIndex={isFocused ? 0 : -1}
      {...(isFocused ? { 'aria-selected': 'true' as const } : {})}
      className={`cal-cell${isWeekend ? ' is-weekend' : ''}`}
      aria-label={buildCellAriaLabel(workerName, dayLabel, shifts)}
      data-testid={`avail-cell-${workerId}-${date}`}
      onKeyDown={(event) => onCellKeyDown(event, workerId, date, row, col)}
      onClick={(event) => onCellClick(event, workerId, date, row, col)}
    >
      <span style={{ display: 'flex', gap: 'var(--space-1)', justifyContent: 'center' }}>
        {SHIFT_TYPES.map((shift) => {
          // `shifts` is the EXCLUDED subset (Availability v3) — a letter present here means the
          // worker is NOT available for it. Visually this must read as a negative/blocked state
          // (struck-through, muted red), the opposite of how a v2 "included" toggle looked (bold,
          // full-opacity, positive ink) — the data was already correct, but before this fix the
          // styling still looked like "on = available", which read backwards against what it now
          // means. An untouched letter (not excluded, i.e. available) gets the positive/default
          // treatment instead.
          const excluded = shifts.includes(shift);
          return (
            <span
              key={shift}
              data-shift={shift}
              aria-hidden="true"
              style={
                excluded
                  ? {
                      fontWeight: 400,
                      color: 'var(--color-status-blocking)',
                      textDecoration: 'line-through',
                      opacity: 0.85,
                    }
                  : {
                      fontWeight: 700,
                      color: 'var(--color-status-good)',
                      textDecoration: 'none',
                      opacity: 1,
                    }
              }
            >
              {shift}
            </span>
          );
        })}
      </span>
    </td>
  );
});

/**
 * Availability v2 grid: rows = active workers, columns = every calendar date of `month`
 * (`buildMonthDays`), cell = an inline A/B/C toggle. NOT a reuse of `packages/ui`'s `CalendarGrid`
 * — that component's shape is fixed at 3 shift rows x day columns with click-opens-a-modal cells;
 * this grid's rows are workers (arbitrary count) and cells are directly inline-editable. It does
 * reuse `CalendarGrid`'s extracted `useRovingTabindex` hook for the keyboard-nav math.
 *
 * Scale: rows are scoped to ACTIVE workers only (reusing `workers.api.ts`'s existing `status`
 * filter, the same mitigation `SlotEditDialog` already uses). The backend now allows up to
 * 1,000-10,000 workers per company, so the row axis is row-virtualized with
 * `@tanstack/react-virtual`'s `useVirtualizer` (see `rowVirtualizer` below): only the `<tr>`s within
 * the current scroll window (+ overscan) are ever mounted, regardless of `workerRows.length`. The
 * date/column axis is NOT virtualized — it's bounded at 31 columns, well within what a plain
 * unvirtualized row can render.
 *
 * Virtualization technique: rather than absolutely-positioning each `<tr>` (which forces
 * `display:block` on the row per the CSS spec, breaking column alignment across rows and the
 * sticky-column/sticky-header CSS below), unrendered rows are represented by a single "spacer"
 * `<tr>` before and after the rendered window, each with one `<td colSpan={days.length + 1}>` sized
 * to the total height of the rows it stands in for (`rowVirtualizer.getVirtualItems()[0].start` /
 * `getTotalSize() - lastItem.end`). Every *rendered* row is a completely normal `<tr>` in normal
 * table flow, so `.availability-scroll`'s sticky header row and sticky first (worker-name) column
 * (below) keep working unmodified — sticky positioning is scoped per-cell against the nearest
 * scrolling ancestor, not affected by how many siblings exist above/below.
 *
 * Keyboard nav across the virtualization boundary: `useRovingTabindex`'s own `focusCell`/
 * `handleNavKeyDown` assume the target cell is already mounted (a real DOM node to call `.focus()`
 * on) — true for `CalendarGrid` (never virtualized) but not here once the target row scrolls out of
 * the rendered window. So this component does its own nav-key handling (`moveFocus` below, built
 * from the same exported `neighborFor`/`isNavKey` primitives `useRovingTabindex` uses internally)
 * that (1) asks the virtualizer to scroll the target row into view
 * (`rowVirtualizer.scrollToIndex`), (2) immediately updates the roving-focus state via
 * `roving.focusCell` so the target cell's `tabIndex`/`aria-selected` are already correct the instant
 * it mounts, and (3) — since the target row may not exist in the DOM yet in the same tick the state
 * updates — remembers the pending target and, in a plain (no-dependency-array) `useEffect` that
 * re-checks after every render, calls `.focus()` on it for real as soon as it's mounted. `focusCell`
 * still handles the common case (target already mounted) synchronously, so most arrow-key presses
 * never touch the pending-focus path at all.
 *
 * State: a local editable `AvailabilityDraft` (see `availabilityDraft.ts`), initialized from
 * `getMonthAvailability` and re-synced whenever that query's data changes (e.g. after a CSV import
 * invalidates the month's `Availability` tag). Saving sends the whole draft as one
 * `replaceMonthAvailability` PUT (`draftToPayload` drops empty cells, so an untouched/cleared date
 * is simply absent from the request body, never sent as an empty array).
 */
export function AvailabilityGrid({ month, companyId }: AvailabilityGridProps): ReactElement {
  const { data: workers } = useListWorkersQuery({ status: 'ACTIVE', companyId });
  const { data: monthAvailability, isLoading } = useGetMonthAvailabilityQuery({ month, companyId });
  const [replaceMonthAvailability, replaceResult] = useReplaceMonthAvailabilityMutation();

  const [draft, setDraft] = useState<AvailabilityDraft>(() => draftFromMonthAvailability(monthAvailability));
  const [saveMessage, setSaveMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Keyed on companyId/month too, not just monthAvailability: this component doesn't remount on a
  // company/month switch, so relying solely on `monthAvailability` identity leaves `saveMessage`
  // (and, for an already-cached target month, `draft`) showing the previous company/month's state
  // for one render.
  useEffect(() => {
    setDraft(draftFromMonthAvailability(monthAvailability));
    setSaveMessage(null);
  }, [monthAvailability, companyId, month]);

  const workerRows = workers ?? [];
  const days = buildMonthDays(month);
  const allDates = days.map((d) => d.date);
  const numRows = workerRows.length;
  const numCols = days.length;

  const roving = useRovingTabindex({ numRows, numCols });
  const { registerCellRef } = roving;

  // A separate, local record of currently-mounted cell elements, fed by the same ref callback as
  // `useRovingTabindex`'s own (private) one -- needed because the hook doesn't expose a way to
  // check "is this row's ref mounted yet", only `focusCell` (look up + focus-if-found). See
  // `moveFocus`/the pending-focus effect below for why that matters once rows are virtualized.
  const mountedCellRefs = useRef(new Map<string, HTMLElement>());
  const combinedRegisterCellRef = useCallback(
    (row: number, col: number, el: HTMLElement | null) => {
      const key = `${row}|${col}`;
      if (el) mountedCellRefs.current.set(key, el);
      else mountedCellRefs.current.delete(key);
      registerCellRef(row, col, el);
    },
    [registerCellRef],
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Initial guess only, used before any row has actually been measured -- corrected per-row by
  // `measureElement` below (each rendered `<tr>`'s real `offsetHeight`), which is what actually
  // sizes the scrollbar/spacer rows once the grid has rendered at least once. Derived from the
  // row's real content: worker name + a row of two `btn--sm` buttons stacked with `--space-1` gaps,
  // inside `.cal-shift-row-head`'s own padding -- roughly two text lines plus padding/border.
  const ROW_HEIGHT_ESTIMATE = 64;
  const rowVirtualizer = useVirtualizer({
    count: numRows,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 8,
  });

  const pendingFocusRef = useRef<GridPos | null>(null);
  // Runs after every render (deliberately no dependency array): cheap when nothing is pending
  // (the common case), and the only reliable way to notice "the row `moveFocus` scrolled to has
  // now mounted" -- that can take more than one render after `scrollToIndex` (the virtualizer's
  // range only updates once it observes the new scroll offset).
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const el = mountedCellRefs.current.get(`${pending.row}|${pending.col}`);
    if (el) {
      el.focus();
      pendingFocusRef.current = null;
    }
  });

  const moveFocus = useCallback(
    (row: number, col: number) => {
      // No-ops (doesn't move scroll) if `row` is already comfortably within the rendered window;
      // otherwise scrolls just far enough to bring it into view.
      rowVirtualizer.scrollToIndex(row, { align: 'auto' });
      // Update the roving-focus state (tabIndex/aria-selected) right away -- and opportunistically
      // move real DOM focus too, which succeeds immediately whenever `row` was already mounted
      // (the vast majority of arrow-key presses, since they move within the current window).
      roving.focusCell(row, col);
      // If DOM focus didn't actually land (target wasn't mounted), the effect above will finish
      // the job once the scrolled-to row mounts.
      if (document.activeElement !== mountedCellRefs.current.get(`${row}|${col}`)) {
        pendingFocusRef.current = { row, col };
      } else {
        pendingFocusRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `roving.focusCell` is stable (see rovingTabindex.ts)
    [rowVirtualizer],
  );

  const toggle = useCallback((workerId: number, date: string, shift: ShiftType) => {
    setDraft((d) => toggleCell(d, workerId, date, shift));
  }, []);

  const handleCellKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableCellElement>, workerId: number, date: string, row: number, col: number) => {
      if (isNavKey(event.key)) {
        const next = neighborFor(event.key, { row, col }, numRows, numCols);
        if (next) {
          event.preventDefault();
          moveFocus(next.row, next.col);
        }
        return;
      }
      if (event.key.length !== 1) return;
      const letter = event.key.toUpperCase();
      if (letter === 'A' || letter === 'B' || letter === 'C') {
        event.preventDefault();
        toggle(workerId, date, letter);
      }
    },
    [numRows, numCols, moveFocus, toggle],
  );

  const handleCellClick = useCallback(
    (event: MouseEvent<HTMLTableCellElement>, workerId: number, date: string, row: number, col: number) => {
      roving.focusCell(row, col);
      const target = event.target as HTMLElement;
      const shiftAttr = target.closest('[data-shift]')?.getAttribute('data-shift');
      if (shiftAttr === 'A' || shiftAttr === 'B' || shiftAttr === 'C') {
        toggle(workerId, date, shiftAttr);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `roving.focusCell` is stable (see rovingTabindex.ts)
    [toggle],
  );

  // Availability v3: toggling every letter ON for every date means EXCLUDED from every shift,
  // every date — i.e. this "All" button now marks the worker fully unavailable all month (the
  // complement of what it meant pre-v3, when an ON letter meant "included"). Renamed from the old
  // `handleSetAllAvailable` to avoid the same stale-name footgun the `shifts` -> `excludedShifts`
  // Prisma rename was meant to prevent — see the Part F design note.
  function handleMarkAllExcluded(workerId: number) {
    setDraft((d) => setAllDatesForWorker(d, workerId, allDates, SHIFT_TYPES));
  }

  // Clears every exclusion for this worker this month — under Availability v3, an entirely absent
  // row means available for everything, so this "None" button now marks the worker fully
  // available all month (previously the opposite: no rows meant fully unavailable).
  function handleClearWorker(workerId: number) {
    setDraft((d) => clearWorkerRow(d, workerId));
  }

  async function handleSave() {
    setSaveMessage(null);
    try {
      await replaceMonthAvailability({ month, companyId, body: draftToPayload(draft) }).unwrap();
      setSaveMessage({ kind: 'success', text: `Availability saved for ${month}.` });
    } catch (err) {
      const classified = classifyMutationError(err);
      const text =
        classified.kind === 'badRequest'
          ? classified.body.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join(' ')
          : 'Could not save availability. Please try again.';
      setSaveMessage({ kind: 'error', text });
    }
  }

  function handleDiscard() {
    setDraft(draftFromMonthAvailability(monthAvailability));
    setSaveMessage(null);
  }

  return (
    <div className="card">
      <div className="card__title">Availability — {month}</div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-secondary)' }}>
        One row per active worker, one column per date. Focus a cell and press <strong>A</strong>,{' '}
        <strong>B</strong>, or <strong>C</strong> to toggle that shift; arrow keys/Home/End move
        between cells. A blank cell means the worker is available for all shifts that date;
        toggling a letter marks that shift as one the worker is NOT available for; toggling all
        three means unavailable the whole day.
      </p>

      {saveMessage ? (
        <p className={saveMessage.kind === 'error' ? 'warn-text' : 'field__hint'} role="status">
          {saveMessage.text}
        </p>
      ) : null}

      {isLoading ? (
        <p>Loading availability…</p>
      ) : (
        <div className="calendar-scroll availability-scroll" ref={scrollContainerRef}>
          <table className="cal-table" aria-label={`${month} availability grid, one row per active worker`}>
            <thead>
              <tr>
                <th scope="col" className="cal-day-head">
                  Worker
                </th>
                {days.map((day) => (
                  <th key={day.date} scope="col" className={`cal-day-head${day.isWeekend ? ' is-weekend' : ''}`}>
                    {day.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const virtualRows = rowVirtualizer.getVirtualItems();
                const totalSize = rowVirtualizer.getTotalSize();
                const firstItem = virtualRows[0];
                const lastItem = virtualRows[virtualRows.length - 1];
                const paddingTop = firstItem ? firstItem.start : 0;
                const paddingBottom = lastItem ? totalSize - lastItem.end : 0;
                const colSpan = numCols + 1;

                return (
                  <>
                    {/* Spacer rows stand in for the un-rendered rows above/below the virtualized
                        window, so the scroll container's scrollbar/height still reflects all
                        `numRows` rows even though only `virtualRows.length` `<tr>`s actually exist —
                        see the class doc comment above for why this (rather than absolutely
                        positioning each row) is what keeps the sticky header/first-column CSS working
                        unmodified. */}
                    {paddingTop > 0 ? (
                      <tr aria-hidden="true">
                        <td style={{ height: paddingTop, padding: 0, border: 'none' }} colSpan={colSpan} />
                      </tr>
                    ) : null}
                    {virtualRows.map((virtualRow) => {
                      const worker = workerRows[virtualRow.index];
                      if (!worker) return null;
                      const rowIndex = virtualRow.index;
                      return (
                        <tr key={worker.id} data-index={rowIndex} ref={rowVirtualizer.measureElement}>
                          <th scope="row" className="cal-shift-row-head">
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                              <span>{worker.name}</span>
                              <span style={{ display: 'flex', gap: 'var(--space-1)' }}>
                                {/* "All" = all shifts available (green) = clears every exclusion for
                                    this worker this month. "None" = none of the shifts available
                                    (blocked) = marks every shift excluded every date. Labels describe
                                    the resulting AVAILABILITY state, not the underlying
                                    excluded-shift storage, since that's how a planner reads these
                                    buttons. */}
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => handleClearWorker(worker.id)}
                                >
                                  All
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  onClick={() => handleMarkAllExcluded(worker.id)}
                                >
                                  None
                                </button>
                              </span>
                            </div>
                          </th>
                          {days.map((day, colIndex) => (
                            <AvailabilityCell
                              key={day.date}
                              row={rowIndex}
                              col={colIndex}
                              workerId={worker.id}
                              workerName={worker.name}
                              date={day.date}
                              dayLabel={day.label}
                              isWeekend={day.isWeekend}
                              shifts={cellShifts(draft, worker.id, day.date)}
                              isFocused={roving.isFocused(rowIndex, colIndex)}
                              registerCellRef={combinedRegisterCellRef}
                              onCellKeyDown={handleCellKeyDown}
                              onCellClick={handleCellClick}
                            />
                          ))}
                        </tr>
                      );
                    })}
                    {paddingBottom > 0 ? (
                      <tr aria-hidden="true">
                        <td style={{ height: paddingBottom, padding: 0, border: 'none' }} colSpan={colSpan} />
                      </tr>
                    ) : null}
                  </>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 'var(--space-4)' }}>
        <button type="button" className="btn btn--secondary" onClick={handleDiscard} disabled={replaceResult.isLoading}>
          Discard changes
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void handleSave()} disabled={replaceResult.isLoading}>
          {replaceResult.isLoading ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
