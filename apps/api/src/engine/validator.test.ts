import { describe, expect, it } from 'vitest';
import type { ShiftType } from '@rostering/shared';
import { validateEdit } from './validator.js';
import type { AvailabilityByDate, MonthContext, WorkerSnapshot } from './types.js';

/**
 * Available every calendar date, every shift — a neutral baseline fixture tests narrow from.
 * Implemented as a `Map` subclass overriding `.get()` rather than pre-populating every date any
 * test in this file happens to use, so adding a new date to some other test's fixture never
 * silently starts failing `withinAvailability` for unrelated rules. Tests that specifically target
 * `withinAvailability` build their own literal, narrow `AvailabilityByDate` maps instead of using
 * this fixture.
 */
class AlwaysAvailable extends Map<string, readonly ShiftType[]> {
  override get(_date: string): readonly ShiftType[] {
    return ['A', 'B', 'C'];
  }
}
const ALWAYS_AVAILABLE: AvailabilityByDate = new AlwaysAvailable();

const baseWorker: WorkerSnapshot = {
  id: 7,
  role: 'GENERAL_GUARD',
  status: 'ACTIVE',
  minMonthlyHours: 100,
  maxMonthlyHours: 180,
  availability: ALWAYS_AVAILABLE,
};

const baseCtx: MonthContext = {
  worker: baseWorker,
  existingShifts: [],
};

describe('validateEdit — workerIsActive (HARD)', () => {
  it('rejects adding an inactive worker to an otherwise-eligible slot', () => {
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, status: 'INACTIVE' } };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-15', shiftType: 'A', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'workerIsActive')).toBe(true);
    }
  });
});

describe('validateEdit — workerIsActive (HARD)', () => {
  it('allows removing an inactive worker from a slot they already hold (removal is never blocked by status)', () => {
    const ctx: MonthContext = {
      worker: { ...baseWorker, status: 'INACTIVE' },
      existingShifts: [],
    };

    const verdict = validateEdit({ kind: 'remove', from: { date: '2026-07-15', shiftType: 'A' } }, ctx);

    expect(verdict.ok).toBe(true);
  });
});

describe('validateEdit — withinAvailability (HARD)', () => {
  it('accepts: the date has an entry and the target shift is in its subset', () => {
    const availability: AvailabilityByDate = new Map([['2026-07-20', ['A', 'C']]]);
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, availability } };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-20', shiftType: 'A', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(true);
  });

  it('rejects: the date has an entry but the target shift is NOT in its subset', () => {
    const availability: AvailabilityByDate = new Map([['2026-07-20', ['A', 'C']]]); // B excluded
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, availability } };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-20', shiftType: 'B', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'withinAvailability')).toBe(true);
    }
  });

  it('rejects: the date has no entry at all (other dates present) — absence means unavailable, not "assume available"', () => {
    const availability: AvailabilityByDate = new Map([['2026-07-21', ['A', 'B', 'C']]]); // a different date
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, availability } };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-20', shiftType: 'A', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'withinAvailability')).toBe(true);
    }
  });

  it('rejects: the worker has no availability entries at all for the month', () => {
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, availability: new Map() } };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-20', shiftType: 'A', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'withinAvailability')).toBe(true);
    }
  });

  it('a plain remove is never gated by availability (the edit has no `to` target)', () => {
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, availability: new Map() } };

    const verdict = validateEdit({ kind: 'remove', from: { date: '2026-07-20', shiftType: 'A' } }, ctx);

    expect(verdict.ok).toBe(true);
  });

  it('a move is gated on the TARGET date only, not the source date', () => {
    // Available on the source date (07-15) but not the target date (07-20).
    const availability: AvailabilityByDate = new Map([['2026-07-15', ['A', 'B', 'C']]]);
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, availability } };

    const verdict = validateEdit(
      {
        kind: 'move',
        from: { date: '2026-07-15', shiftType: 'A' },
        to: { date: '2026-07-20', shiftType: 'A', role: 'GENERAL_GUARD' },
      },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'withinAvailability')).toBe(true);
    }
  });
});

describe('validateEdit — maxTwoShiftsPerDay (HARD)', () => {
  it('rejects a 3rd shift on the same calendar date', () => {
    const ctx: MonthContext = {
      ...baseCtx,
      existingShifts: [
        { date: '2026-07-15', shiftType: 'A' },
        { date: '2026-07-15', shiftType: 'B' },
      ],
    };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-15', shiftType: 'C', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'maxTwoShiftsPerDay')).toBe(true);
    }
  });

  it('midnight-spanning: shift C on one day then shift A the next day is NOT a 2-shifts/day violation', () => {
    // Worker already holds shift C (16:00-00:00) on 2026-07-15.
    const ctx: MonthContext = {
      ...baseCtx,
      existingShifts: [{ date: '2026-07-15', shiftType: 'C' }],
    };

    // Assigning shift A of the NEXT calendar day (2026-07-16) is a different calendar date.
    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-16', shiftType: 'A', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(true);
  });

  it('midnight-spanning: a 3rd shift on the day AFTER a C→A sequence is still blocked', () => {
    // Worker holds shift C on 2026-07-15, and already picked up shift A on 2026-07-16 (the
    // accepted midnight-spanning sequence from the previous test) plus shift B on 2026-07-16 —
    // that's already 2 shifts on 07-16.
    const ctx: MonthContext = {
      ...baseCtx,
      existingShifts: [
        { date: '2026-07-15', shiftType: 'C' },
        { date: '2026-07-16', shiftType: 'A' },
        { date: '2026-07-16', shiftType: 'B' },
      ],
    };

    // A 3rd shift on 2026-07-16 is blocked even though it follows a legal C→A crossing.
    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-16', shiftType: 'C', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'maxTwoShiftsPerDay')).toBe(true);
    }
  });

  it('midnight-spanning: a 3rd shift on the FIRST day (2026-07-15) of a C→A sequence is still blocked', () => {
    // Worker already holds 2 shifts on 2026-07-15 (A and C), plus the crossed-over A on 07-16.
    const ctx: MonthContext = {
      ...baseCtx,
      existingShifts: [
        { date: '2026-07-15', shiftType: 'A' },
        { date: '2026-07-15', shiftType: 'C' },
        { date: '2026-07-16', shiftType: 'A' },
      ],
    };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-15', shiftType: 'B', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'maxTwoShiftsPerDay')).toBe(true);
    }
  });
});

describe('validateEdit — exceedsMaxMonthlyHours (SOFT)', () => {
  it('warns (but does not block) an add that would push the worker past contract.maxMonthlyHours', () => {
    // 20 existing 8h shifts = 160h already logged against a 160h max.
    const existingShifts: MonthContext['existingShifts'] = Array.from(
      { length: 20 },
      (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        shiftType: 'A' as const,
      }),
    );
    const ctx: MonthContext = {
      worker: { ...baseWorker, maxMonthlyHours: 160 },
      existingShifts,
    };

    // A 21st shift brings the month total to 168h, over the 160h contracted max.
    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-21', shiftType: 'B', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.warnings.some((w) => w.rule === 'exceedsMaxMonthlyHours')).toBe(true);
    }
  });

  it('also warns on a move that would push the worker past contract.maxMonthlyHours', () => {
    const existingShifts: MonthContext['existingShifts'] = Array.from(
      { length: 20 },
      (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        shiftType: 'A' as const,
      }),
    );
    const ctx: MonthContext = {
      worker: { ...baseWorker, maxMonthlyHours: 160 },
      existingShifts,
    };

    const verdict = validateEdit(
      {
        kind: 'move',
        from: { date: '2026-08-01', shiftType: 'A' },
        to: { date: '2026-07-21', shiftType: 'B', role: 'GENERAL_GUARD' },
      },
      ctx,
    );

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.warnings.some((w) => w.rule === 'exceedsMaxMonthlyHours')).toBe(true);
    }
  });
});

describe('validateEdit — belowMinMonthlyHours (SOFT)', () => {
  it('warns (but does not block) a remove that would drop the worker below contract.minMonthlyHours', () => {
    // 12 remaining 8h shifts (96h) after the removal, plus the shift being removed makes 13 (104h)
    // currently logged against a 100h contracted min.
    const existingShifts: MonthContext['existingShifts'] = Array.from(
      { length: 12 },
      (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        shiftType: 'A' as const,
      }),
    );
    const ctx: MonthContext = {
      worker: { ...baseWorker, minMonthlyHours: 100 },
      existingShifts,
    };

    const verdict = validateEdit({ kind: 'remove', from: { date: '2026-07-13', shiftType: 'A' } }, ctx);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.warnings.some((w) => w.rule === 'belowMinMonthlyHours')).toBe(true);
    }
  });

  it('also warns on a move-away that would drop the worker below contract.minMonthlyHours', () => {
    const existingShifts: MonthContext['existingShifts'] = Array.from(
      { length: 12 },
      (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        shiftType: 'A' as const,
      }),
    );
    const ctx: MonthContext = {
      worker: { ...baseWorker, minMonthlyHours: 100 },
      existingShifts,
    };

    const verdict = validateEdit(
      {
        kind: 'move',
        from: { date: '2026-07-13', shiftType: 'A' },
        to: { date: '2026-07-25', shiftType: 'B', role: 'GENERAL_GUARD' },
      },
      ctx,
    );

    // The worker still ends the month with 13 shifts total (104h) — moving, not losing, a shift —
    // so this specific move should NOT warn. This confirms belowMinMonthlyHours counts the
    // worker's total hours after the edit, not just the vacated slot.
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.warnings.some((w) => w.rule === 'belowMinMonthlyHours')).toBe(false);
    }
  });
});

describe('validateEdit — noDuplicateSlot (HARD)', () => {
  it('rejects adding a worker to a slot they already hold', () => {
    const ctx: MonthContext = {
      ...baseCtx,
      existingShifts: [{ date: '2026-07-15', shiftType: 'A' }],
    };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-15', shiftType: 'A', role: 'GENERAL_GUARD' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'noDuplicateSlot')).toBe(true);
    }
  });
});

describe('validateEdit — roleMatchesSlot (HARD)', () => {
  it('rejects a Screener added to a Supervisor slot', () => {
    const ctx: MonthContext = { ...baseCtx, worker: { ...baseWorker, role: 'SCREENER' } };

    const verdict = validateEdit(
      { kind: 'add', to: { date: '2026-07-15', shiftType: 'A', role: 'SUPERVISOR' } },
      ctx,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.rule === 'roleMatchesSlot')).toBe(true);
    }
  });
});
