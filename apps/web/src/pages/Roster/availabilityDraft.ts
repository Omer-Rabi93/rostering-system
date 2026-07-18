import { SHIFT_TYPES } from '@rostering/shared';
import type { MonthAvailability, ShiftType } from '@rostering/shared';

/**
 * Local editable draft of a month's availability grid — same sparse shape as `MonthAvailability`
 * (`{ [workerId]: { [date]: ShiftSubset } }`), kept as its own type so `AvailabilityGrid` isn't
 * required to funnel every keystroke through a network round-trip: the draft is edited entirely
 * client-side and turned into a single `PUT` payload on Save (`draftToPayload`).
 *
 * Sparse by construction, same as the wire shape: a worker/date with no availability has NO key —
 * `toggleCell` deletes empty date/worker entries rather than ever storing an empty array. Every
 * lookup (`cellShifts`) therefore treats `undefined` as the real "unavailable" state, never
 * coalesced away with a non-null assertion (`noUncheckedIndexedAccess` pitfall from the plan).
 */
export type AvailabilityDraft = Readonly<Record<string, Readonly<Record<string, readonly ShiftType[]>>>>;

export function draftFromMonthAvailability(data: MonthAvailability | undefined): AvailabilityDraft {
  return data ?? {};
}

/** Shared empty-subset constant, returned (never a fresh `[]` literal) for every "no entry" cell —
 * a stable reference lets `AvailabilityGrid` wrap its cell renderer in `React.memo` and have every
 * untouched cell in a large worker x date grid skip re-rendering on an unrelated cell's toggle. */
const EMPTY_SHIFTS: readonly ShiftType[] = [];

/** The shift subset for one (worker, date) cell — `[]` (not `undefined`) when there is no entry,
 * since absence of a row IS the "unavailable that date" state, not an exceptional case. */
export function cellShifts(draft: AvailabilityDraft, workerId: number, date: string): readonly ShiftType[] {
  return draft[String(workerId)]?.[date] ?? EMPTY_SHIFTS;
}

function toggleInSubset(current: readonly ShiftType[], shift: ShiftType): ShiftType[] {
  const next = current.includes(shift) ? current.filter((s) => s !== shift) : [...current, shift];
  // Re-derive in canonical A<B<C order from SHIFT_TYPES rather than trusting insertion order —
  // matches `shiftSubsetSchema`'s canonical-order requirement on the wire.
  return SHIFT_TYPES.filter((s) => next.includes(s));
}

/** Immutable toggle of exactly one shift letter on one (worker, date) cell. Toggling the last
 * remaining letter off removes the date entry; if that was the worker's only date, the worker
 * entry is removed too — the draft never carries an empty array or empty object. */
export function toggleCell(
  draft: AvailabilityDraft,
  workerId: number,
  date: string,
  shift: ShiftType,
): AvailabilityDraft {
  const key = String(workerId);
  const current = cellShifts(draft, workerId, date);
  const nextShifts = toggleInSubset(current, shift);

  const workerRow: Record<string, readonly ShiftType[]> = { ...(draft[key] ?? {}) };
  if (nextShifts.length === 0) {
    delete workerRow[date];
  } else {
    workerRow[date] = nextShifts;
  }

  const next: Record<string, Readonly<Record<string, readonly ShiftType[]>>> = { ...draft, [key]: workerRow };
  if (Object.keys(workerRow).length === 0) {
    delete next[key];
  }
  return next;
}

/** Bulk-set every date in `dates` to exactly `shifts` for one worker — backs the grid's minimal
 * "set all" bulk action (e.g. "Mark this worker fully available all month"). Passing an empty
 * `shifts` array clears the worker's whole row (equivalent to `clearWorkerRow`). */
export function setAllDatesForWorker(
  draft: AvailabilityDraft,
  workerId: number,
  dates: readonly string[],
  shifts: readonly ShiftType[],
): AvailabilityDraft {
  const canonical = SHIFT_TYPES.filter((s) => shifts.includes(s));
  const key = String(workerId);
  if (canonical.length === 0) {
    if (!(key in draft)) return draft;
    const next = { ...draft };
    delete next[key];
    return next;
  }
  const workerRow: Record<string, readonly ShiftType[]> = {};
  for (const date of dates) {
    workerRow[date] = canonical;
  }
  return { ...draft, [key]: workerRow };
}

/** Clears every date for one worker — the worker key is removed entirely (sparse). */
export function clearWorkerRow(draft: AvailabilityDraft, workerId: number): AvailabilityDraft {
  const key = String(workerId);
  if (!(key in draft)) return draft;
  const next = { ...draft };
  delete next[key];
  return next;
}

/** Converts the draft into the exact sparse `MonthAvailability` shape the `PUT` endpoint expects
 * — defensively re-filters empty entries (the draft is already sparse by construction via
 * `toggleCell`, but this is the one function whose contract callers rely on, so it doesn't trust
 * that invariant silently). */
export function draftToPayload(draft: AvailabilityDraft): MonthAvailability {
  const payload: Record<string, Record<string, ShiftType[]>> = {};
  for (const [workerId, dates] of Object.entries(draft)) {
    const dateEntries = Object.entries(dates).filter(([, shifts]) => shifts.length > 0);
    if (dateEntries.length === 0) continue;
    payload[workerId] = Object.fromEntries(dateEntries.map(([date, shifts]) => [date, [...shifts]]));
  }
  return payload;
}
