import { memo, useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactElement } from 'react';
import { useRovingTabindex } from '@rostering/ui';
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

function buildCellAriaLabel(workerName: string, dayLabel: string, shifts: readonly ShiftType[]): string {
  const subsetText = shifts.length === 0 ? 'unavailable' : `available shift ${shifts.join(', ')}`;
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
          const on = shifts.includes(shift);
          return (
            <span
              key={shift}
              data-shift={shift}
              aria-hidden="true"
              style={{
                fontWeight: on ? 700 : 400,
                color: on ? 'var(--color-ink-primary)' : 'var(--color-ink-secondary)',
                opacity: on ? 1 : 0.4,
              }}
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
 * filter, the same mitigation `SlotEditDialog` already uses) — the plan's own scale note treats
 * that as sufficient for the app's stated 50-150-worker org size without adding virtualization.
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

  useEffect(() => {
    setDraft(draftFromMonthAvailability(monthAvailability));
  }, [monthAvailability]);

  const workerRows = workers ?? [];
  const days = buildMonthDays(month);
  const allDates = days.map((d) => d.date);

  const roving = useRovingTabindex({ numRows: workerRows.length, numCols: days.length });
  const { registerCellRef, handleNavKeyDown } = roving;

  const toggle = useCallback((workerId: number, date: string, shift: ShiftType) => {
    setDraft((d) => toggleCell(d, workerId, date, shift));
  }, []);

  const handleCellKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableCellElement>, workerId: number, date: string, row: number, col: number) => {
      if (handleNavKeyDown(event, row, col)) return;
      if (event.key.length !== 1) return;
      const letter = event.key.toUpperCase();
      if (letter === 'A' || letter === 'B' || letter === 'C') {
        event.preventDefault();
        toggle(workerId, date, letter);
      }
    },
    [handleNavKeyDown, toggle],
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

  function handleSetAllAvailable(workerId: number) {
    setDraft((d) => setAllDatesForWorker(d, workerId, allDates, SHIFT_TYPES));
  }

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
        between cells. A blank cell means unavailable that date.
      </p>

      {saveMessage ? (
        <p className={saveMessage.kind === 'error' ? 'warn-text' : 'field__hint'} role="status">
          {saveMessage.text}
        </p>
      ) : null}

      {isLoading ? (
        <p>Loading availability…</p>
      ) : (
        <div className="calendar-scroll">
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
              {workerRows.map((worker, rowIndex) => (
                <tr key={worker.id}>
                  <th scope="row" className="cal-shift-row-head">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                      <span>{worker.name}</span>
                      <span style={{ display: 'flex', gap: 'var(--space-1)' }}>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => handleSetAllAvailable(worker.id)}>
                          All
                        </button>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => handleClearWorker(worker.id)}>
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
                      registerCellRef={registerCellRef}
                      onCellKeyDown={handleCellKeyDown}
                      onCellClick={handleCellClick}
                    />
                  ))}
                </tr>
              ))}
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
