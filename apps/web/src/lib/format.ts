import type { Month } from '@rostering/shared';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH_NAMES_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parses a `YYYY-MM` month string into its numeric parts without ever touching a local-timezone
 * `Date`, since a naive `new Date('2026-08-01')` shifts across midnight in timezones west of UTC. */
export function parseMonth(month: Month): { year: number; monthIndex: number } {
  const [yearStr, monthStr] = month.split('-');
  return { year: Number(yearStr), monthIndex: Number(monthStr) - 1 };
}

/** "2026-08" -> "August 2026" */
export function formatMonthLong(month: Month): string {
  const { year, monthIndex } = parseMonth(month);
  return `${MONTH_NAMES[monthIndex] ?? month} ${year}`;
}

/** Formats a `YYYY-MM-DD` date string as "Aug 12" — always parsed as a UTC calendar date, never
 * shifted by the browser's local timezone. */
export function formatDayLabel(date: string): string {
  const parts = date.split('-');
  const monthIndex = Number(parts[1]) - 1;
  const day = Number(parts[2]);
  return `${MONTH_NAMES_SHORT[monthIndex] ?? '?'} ${day}`;
}

/** 0=Sunday .. 6=Saturday for a `YYYY-MM-DD` date, computed via `Date.UTC` (never local time). */
export function dayOfWeekIndex(date: string): number {
  const parts = date.split('-').map(Number);
  const [year, month, day] = parts;
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

export function dayOfWeekName(date: string, style: 'long' | 'short' = 'long'): string {
  const idx = dayOfWeekIndex(date);
  return (style === 'long' ? DAY_NAMES[idx] : DAY_NAMES_SHORT[idx]) ?? '';
}

/** Israeli weekend: Friday + Saturday. */
export function isWeekend(date: string): boolean {
  const idx = dayOfWeekIndex(date);
  return idx === 5 || idx === 6;
}

/** Formats an ILS amount the way the mockups do: "₪612,480" (no decimals — costs are always
 * whole-shekel in the design), using a fixed `en-US` grouping so the output doesn't depend on the
 * host machine's locale (important for deterministic tests). */
export function formatIls(amount: number): string {
  const rounded = Math.round(amount);
  return `₪${rounded.toLocaleString('en-US')}`;
}
