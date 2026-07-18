import type { KeyboardEvent, ReactElement } from 'react';

import { useRovingTabindex, type GridPos } from './rovingTabindex.js';
import { ROLE_CLASS } from '../Badge/Badge.js';

export type Role = 'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER';
export type ShiftType = 'A' | 'B' | 'C';

export type DayColumn = {
  date: string; // YYYY-MM-DD
  label: string; // e.g. "Aug 12"
  isWeekend?: boolean;
};

export type SlotWorker = { id: number; name: string; role: Role };

export type SlotData = {
  workers: SlotWorker[];
  alertSeverity?: 'warning' | 'blocking';
};

export type FocusedSlot = { date: string; shift: ShiftType };

export type CalendarGridProps = {
  month: string; // "YYYY-MM"
  days: DayColumn[]; // one per calendar day, 28-31 entries
  shiftRows: readonly ['A', 'B', 'C'];
  getSlot: (date: string, shift: ShiftType) => SlotData;
  onSlotActivate: (date: string, shift: ShiftType) => void; // Enter/Space or click
  /** Roving-tabindex focus, lifted by the caller (e.g. into a Redux slice). When
   * omitted, CalendarGrid manages the focused cell itself (uncontrolled). When
   * provided, it is the source of truth for which cell is focused (controlled) —
   * the caller must also handle `onFocusSlot` and feed the result back in, the
   * same pattern as a controlled `<input value>`. */
  focusedSlot?: FocusedSlot;
  /** Notified whenever the roving-focused cell changes, whether from a click, an
   * arrow-key/Home/End move, or Enter/Space activation — regardless of whether
   * `focusedSlot` is controlled, so a caller can always observe focus moves. */
  onFocusSlot?: (date: string, shift: ShiftType) => void;
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function buildAriaLabel(day: DayColumn, shift: ShiftType, slot: SlotData): string {
  const workerText = pluralize(slot.workers.length, 'worker');
  const alertText = slot.alertSeverity ? '1 alert' : 'no alerts';
  return `${day.label}, Shift ${shift}, ${workerText}, ${alertText}`;
}

export function CalendarGrid({
  month,
  days,
  shiftRows,
  getSlot,
  onSlotActivate,
  focusedSlot,
  onFocusSlot,
}: CalendarGridProps): ReactElement {
  function posForSlot(date: string, shift: ShiftType): GridPos {
    const col = days.findIndex((d) => d.date === date);
    const row = shiftRows.indexOf(shift);
    return { row: row === -1 ? 0 : row, col: col === -1 ? 0 : col };
  }

  function slotForPos(pos: GridPos): FocusedSlot {
    return { date: days[pos.col]?.date ?? '', shift: shiftRows[pos.row] ?? 'A' };
  }

  const roving = useRovingTabindex({
    numRows: shiftRows.length,
    numCols: days.length,
    ...(focusedSlot ? { focusedPos: posForSlot(focusedSlot.date, focusedSlot.shift) } : {}),
    ...(onFocusSlot
      ? {
          onFocusChange: (pos: GridPos) => {
            const slot = slotForPos(pos);
            onFocusSlot(slot.date, slot.shift);
          },
        }
      : {}),
  });

  const focused = slotForPos(roving.focusedPos);

  function handleKeyDown(event: KeyboardEvent<HTMLTableCellElement>, date: string, shift: ShiftType) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSlotActivate(date, shift);
      return;
    }
    const pos = posForSlot(date, shift);
    roving.handleNavKeyDown(event, pos.row, pos.col);
  }

  function handleClick(date: string, shift: ShiftType) {
    const pos = posForSlot(date, shift);
    roving.focusCell(pos.row, pos.col);
    onSlotActivate(date, shift);
  }

  return (
    <div className="calendar">
      <div className="calendar-scroll">
        <table className="cal-table" aria-label={`${month} roster grid, Shift A B C per day`}>
          <thead>
            <tr>
              <th scope="col" className="cal-day-head">
                <span className="visually-hidden">Shift</span>
              </th>
              {days.map((day) => (
                <th
                  key={day.date}
                  scope="col"
                  className={`cal-day-head${day.isWeekend ? ' is-weekend' : ''}`}
                >
                  {day.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shiftRows.map((shift, rowIndex) => (
              <tr key={shift}>
                <th scope="row" className="cal-shift-row-head">
                  {shift}
                </th>
                {days.map((day, colIndex) => {
                  const slot = getSlot(day.date, shift);
                  const isFocused = focused.date === day.date && focused.shift === shift;
                  const alertClass =
                    slot.alertSeverity === 'warning'
                      ? ' has-alert'
                      : slot.alertSeverity === 'blocking'
                        ? ' has-blocking'
                        : '';
                  return (
                    <td
                      key={day.date}
                      ref={(el) => roving.registerCellRef(rowIndex, colIndex, el)}
                      className={`cal-cell${alertClass}`}
                      role="gridcell"
                      tabIndex={isFocused ? 0 : -1}
                      {...(isFocused ? { 'aria-selected': 'true' as const } : {})}
                      aria-label={buildAriaLabel(day, shift, slot)}
                      data-testid={`cal-cell-${day.date}-${shift}`}
                      onClick={() => handleClick(day.date, shift)}
                      onKeyDown={(event) => handleKeyDown(event, day.date, shift)}
                    >
                      {slot.workers.length === 0 ? (
                        <span className="cal-cell-empty-hint">Unassigned</span>
                      ) : (
                        slot.workers.map((worker) => (
                          <span className={`cal-chip cal-chip--${ROLE_CLASS[worker.role]}`} key={worker.id}>
                            {worker.name}
                          </span>
                        ))
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
