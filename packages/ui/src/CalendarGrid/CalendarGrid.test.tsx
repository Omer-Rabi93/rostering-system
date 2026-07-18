import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CalendarGrid } from './CalendarGrid';
import type { CalendarGridProps, DayColumn, Role, ShiftType } from './CalendarGrid';

const SHIFT_ROWS = ['A', 'B', 'C'] as const;

function makeDays(count: number, month: string): DayColumn[] {
  const days: DayColumn[] = [];
  for (let i = 1; i <= count; i += 1) {
    const dd = String(i).padStart(2, '0');
    days.push({
      date: `${month}-${dd}`,
      label: `Aug ${i}`,
      ...(i % 7 === 0 || i % 7 === 6 ? { isWeekend: true } : {}),
    });
  }
  return days;
}

type SlotFixture = {
  workers: { id: number; name: string; role: Role }[];
  alertSeverity?: 'warning' | 'blocking';
};

function makeGetSlot(overrides: Record<string, SlotFixture> = {}) {
  return (date: string, shift: ShiftType) => {
    const key = `${date}|${shift}`;
    return overrides[key] ?? { workers: [] };
  };
}

function renderGrid(overrides: Partial<CalendarGridProps> = {}) {
  const days = overrides.days ?? makeDays(31, '2026-08');
  const props: CalendarGridProps = {
    month: '2026-08',
    days,
    shiftRows: SHIFT_ROWS,
    getSlot: makeGetSlot(),
    onSlotActivate: vi.fn(),
    ...overrides,
  };
  return { ...render(<CalendarGrid {...props} />), props };
}

describe('CalendarGrid', () => {
  it('renders one column header per day and exactly 3 shift rows for a 31-day month', () => {
    const days = makeDays(31, '2026-08');
    renderGrid({ days });

    const table = screen.getByRole('table');
    // +1 accounts for the blank corner header cell that aligns with the row-head column.
    expect(within(table).getAllByRole('columnheader')).toHaveLength(31 + 1);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(table.querySelectorAll('td.cal-cell')).toHaveLength(31 * 3);
  });

  it('renders one column header per day and exactly 3 shift rows for a 28-day month', () => {
    const days = makeDays(28, '2026-02');
    renderGrid({ days, month: '2026-02' });

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(28 + 1);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(table.querySelectorAll('td.cal-cell')).toHaveLength(28 * 3);
  });

  it('has exactly one cell with tabIndex 0 and every other cell at tabIndex -1', () => {
    renderGrid({ days: makeDays(28, '2026-02') });

    const cells = screen.getAllByRole('gridcell');
    const zeroTabIndex = cells.filter((cell) => cell.tabIndex === 0);
    const negativeTabIndex = cells.filter((cell) => cell.tabIndex === -1);

    expect(zeroTabIndex).toHaveLength(1);
    expect(negativeTabIndex).toHaveLength(cells.length - 1);
  });

  it('builds the aria-label from worker count and alert state, and renders worker chips', () => {
    const days = makeDays(28, '2026-02');
    const targetDate = '2026-02-05';
    renderGrid({
      days,
      getSlot: makeGetSlot({
        [`${targetDate}|B`]: {
          workers: [
            { id: 1, name: 'D. Levi', role: 'GENERAL_GUARD' },
            { id: 2, name: 'O. Cohen', role: 'SUPERVISOR' },
            { id: 3, name: 'Y. Peretz', role: 'SCREENER' },
          ],
          alertSeverity: 'warning',
        },
      }),
    });

    const cell = screen.getByTestId(`cal-cell-${targetDate}-B`);
    const label = cell.getAttribute('aria-label') ?? '';
    expect(label).toContain('3 workers');
    expect(label).toContain('1 alert');
    expect(cell).toHaveClass('has-alert');
    expect(within(cell).getByText('D. Levi')).toBeInTheDocument();
    expect(within(cell).getByText('O. Cohen')).toBeInTheDocument();
    expect(within(cell).getByText('Y. Peretz')).toBeInTheDocument();
  });

  it('colors each worker chip by their role', () => {
    const days = makeDays(28, '2026-02');
    const targetDate = '2026-02-05';
    renderGrid({
      days,
      getSlot: makeGetSlot({
        [`${targetDate}|B`]: {
          workers: [
            { id: 1, name: 'D. Levi', role: 'GENERAL_GUARD' },
            { id: 2, name: 'O. Cohen', role: 'SUPERVISOR' },
            { id: 3, name: 'Y. Peretz', role: 'SCREENER' },
          ],
        },
      }),
    });

    const cell = screen.getByTestId(`cal-cell-${targetDate}-B`);
    expect(within(cell).getByText('D. Levi')).toHaveClass('cal-chip', 'cal-chip--guard');
    expect(within(cell).getByText('O. Cohen')).toHaveClass('cal-chip', 'cal-chip--supervisor');
    expect(within(cell).getByText('Y. Peretz')).toHaveClass('cal-chip', 'cal-chip--screener');
  });

  it('shows an "Unassigned" hint when a slot has no workers', () => {
    const days = makeDays(28, '2026-02');
    renderGrid({ days });

    const cell = screen.getByTestId(`cal-cell-${days[0]?.date}-A`);
    expect(cell.getAttribute('aria-label')).toContain('0 workers');
    expect(cell.getAttribute('aria-label')).toContain('no alerts');
    expect(within(cell).getByText(/unassigned/i)).toBeInTheDocument();
  });

  it('calls onSlotActivate with the clicked cell\'s date and shift', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    const onSlotActivate = vi.fn();
    renderGrid({ days, onSlotActivate });

    const cell = screen.getByTestId(`cal-cell-${days[9]?.date}-B`);
    await user.click(cell);

    expect(onSlotActivate).toHaveBeenCalledWith(days[9]?.date, 'B');
  });

  it('calls onSlotActivate for the focused cell on Enter and prevents Space from scrolling', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    const onSlotActivate = vi.fn();
    renderGrid({ days, onSlotActivate });

    // The default-focused cell is the first day, first shift row (A).
    const cell = screen.getByTestId(`cal-cell-${days[0]?.date}-A`);
    cell.focus();

    await user.keyboard('{Enter}');
    expect(onSlotActivate).toHaveBeenCalledWith(days[0]?.date, 'A');

    onSlotActivate.mockClear();
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    const prevented = !cell.dispatchEvent(spaceEvent);
    expect(prevented).toBe(true);
    expect(onSlotActivate).toHaveBeenCalledWith(days[0]?.date, 'A');
  });

  it('moves DOM focus to the next day in the same row on ArrowRight', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    renderGrid({ days });

    const first = screen.getByTestId(`cal-cell-${days[0]?.date}-A`);
    first.focus();
    await user.keyboard('{ArrowRight}');

    const expected = screen.getByTestId(`cal-cell-${days[1]?.date}-A`);
    expect(document.activeElement).toBe(expected);
    expect(expected.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
  });

  it('wraps ArrowRight from the last day of a row to the first day of the next shift row', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    renderGrid({ days });

    const lastDayA = days[days.length - 1];
    const startCell = screen.getByTestId(`cal-cell-${lastDayA?.date}-A`);
    startCell.focus();
    await user.keyboard('{ArrowRight}');

    const expected = screen.getByTestId(`cal-cell-${days[0]?.date}-B`);
    expect(document.activeElement).toBe(expected);
  });

  it('mirrors wrapping backwards on ArrowLeft', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    renderGrid({ days });

    const startCell = screen.getByTestId(`cal-cell-${days[0]?.date}-B`);
    startCell.focus();
    await user.keyboard('{ArrowLeft}');

    const expected = screen.getByTestId(`cal-cell-${days[days.length - 1]?.date}-A`);
    expect(document.activeElement).toBe(expected);
  });

  it('moves focus vertically between shift rows on the same day with ArrowDown/ArrowUp', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    renderGrid({ days });

    const cellA = screen.getByTestId(`cal-cell-${days[3]?.date}-A`);
    cellA.focus();
    await user.keyboard('{ArrowDown}');

    const cellB = screen.getByTestId(`cal-cell-${days[3]?.date}-B`);
    expect(document.activeElement).toBe(cellB);

    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(cellA);
  });

  it('jumps to the first/last day of the current row on Home/End', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    renderGrid({ days });

    const midCell = screen.getByTestId(`cal-cell-${days[10]?.date}-C`);
    midCell.focus();
    await user.keyboard('{End}');

    const lastCell = screen.getByTestId(`cal-cell-${days[days.length - 1]?.date}-C`);
    expect(document.activeElement).toBe(lastCell);

    await user.keyboard('{Home}');
    const firstCell = screen.getByTestId(`cal-cell-${days[0]?.date}-C`);
    expect(document.activeElement).toBe(firstCell);
  });

  it('activates the actually-focused cell after an arrow move, not the originally-rendered tabIndex-0 cell', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    const onSlotActivate = vi.fn();
    renderGrid({ days, onSlotActivate });

    const first = screen.getByTestId(`cal-cell-${days[0]?.date}-A`);
    first.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');

    expect(onSlotActivate).toHaveBeenCalledTimes(1);
    expect(onSlotActivate).toHaveBeenCalledWith(days[2]?.date, 'A');
  });

  it('calls onFocusSlot whenever roving focus moves, and respects a controlled focusedSlot prop', async () => {
    const user = userEvent.setup();
    const days = makeDays(28, '2026-02');
    const onFocusSlot = vi.fn();

    const { rerender, props } = renderGrid({
      days,
      focusedSlot: { date: days[0]?.date ?? '', shift: 'A' },
      onFocusSlot,
    });

    const first = screen.getByTestId(`cal-cell-${days[0]?.date}-A`);
    expect(first.tabIndex).toBe(0);

    first.focus();
    await user.keyboard('{ArrowRight}');

    // Controlled: internal DOM focus moves and onFocusSlot fires, but tabIndex
    // bookkeeping stays driven by the (unchanged) focusedSlot prop until the
    // caller feeds the new value back in.
    expect(onFocusSlot).toHaveBeenCalledWith(days[1]?.date, 'A');
    expect(first.tabIndex).toBe(0);

    rerender(<CalendarGrid {...props} focusedSlot={{ date: days[1]?.date ?? '', shift: 'A' }} onFocusSlot={onFocusSlot} />);
    const second = screen.getByTestId(`cal-cell-${days[1]?.date}-A`);
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
  });
});
