import { describe, expect, it } from 'vitest';
import { buildProblem, parseSolverSolution } from './problem.js';
import type { EngineWorkerInput } from './problem.js';

describe('buildProblem — month day generation', () => {
  it('generates every calendar date of a known 31-day month (July 2026)', () => {
    const problem = buildProblem({ month: '2026-07', workers: [], requirements: [], availability: [] });

    expect(problem.days).toHaveLength(31);
    expect(problem.days[0]).toBe('2026-07-01');
    expect(problem.days[30]).toBe('2026-07-31');
  });

  it('generates 28 days for February of a non-leap year (2026-02)', () => {
    const problem = buildProblem({ month: '2026-02', workers: [], requirements: [], availability: [] });

    expect(problem.days).toHaveLength(28);
    expect(problem.days[27]).toBe('2026-02-28');
  });

  it('generates 29 days for February of a leap year (2028-02)', () => {
    const problem = buildProblem({ month: '2028-02', workers: [], requirements: [], availability: [] });

    expect(problem.days).toHaveLength(29);
    expect(problem.days[28]).toBe('2028-02-29');
  });
});

describe('buildProblem — workers passthrough with date-keyed availability attached', () => {
  it('carries the worker fields through unchanged, augmented with its availability rows as a date->shifts object', () => {
    const worker: EngineWorkerInput = {
      id: 7,
      role: 'SUPERVISOR',
      minMonthlyHours: 100,
      maxMonthlyHours: 180,
    };

    const problem = buildProblem({
      month: '2026-07',
      workers: [worker],
      requirements: [],
      availability: [
        { workerId: 7, date: '2026-07-01', shifts: ['A', 'C'] },
        { workerId: 7, date: '2026-07-02', shifts: ['B'] },
      ],
    });

    expect(problem.workers).toEqual([
      { ...worker, availability: { '2026-07-01': ['A', 'C'], '2026-07-02': ['B'] } },
    ]);
  });

  it('a worker with zero availability rows gets an empty availability object (buildProblem itself has no opinion on what a missing date means -- that is solve_roster.py\'s default, Availability v3: missing = available every shift)', () => {
    const worker: EngineWorkerInput = { id: 9, role: 'GENERAL_GUARD', minMonthlyHours: 0, maxMonthlyHours: 100 };

    const problem = buildProblem({ month: '2026-07', workers: [worker], requirements: [], availability: [] });

    expect(problem.workers).toEqual([{ ...worker, availability: {} }]);
  });

  it("one worker's availability rows never leak into another worker's map", () => {
    const workerA: EngineWorkerInput = { id: 1, role: 'GENERAL_GUARD', minMonthlyHours: 0, maxMonthlyHours: 100 };
    const workerB: EngineWorkerInput = { id: 2, role: 'GENERAL_GUARD', minMonthlyHours: 0, maxMonthlyHours: 100 };

    const problem = buildProblem({
      month: '2026-07',
      workers: [workerA, workerB],
      requirements: [],
      availability: [{ workerId: 2, date: '2026-07-05', shifts: ['A'] }],
    });

    const a = problem.workers.find((w) => w.id === 1);
    const b = problem.workers.find((w) => w.id === 2);
    expect(a?.availability).toEqual({});
    expect(b?.availability).toEqual({ '2026-07-05': ['A'] });
  });
});

describe('buildProblem — staffing requirements crossed with every day of the month', () => {
  it('expands a role×shift requirement matrix into one {date, shift, role, requiredCount} row per day', () => {
    // The solver's role-coverage constraint (design doc: `for (d, s, role, required) in
    // p.requirements`) needs a fully day-scoped requirements list — the staffing-requirements
    // matrix itself (role × shift only) applies uniformly to every calendar day of the month, so
    // `buildProblem` is responsible for the crossing, not the solver.
    const requirement = { role: 'SUPERVISOR' as const, shift: 'A' as const, requiredCount: 2 };

    const problem = buildProblem({
      month: '2026-02', // non-leap Feb, 28 days — a small, exact fixture
      workers: [],
      requirements: [requirement],
      availability: [],
    });

    expect(problem.requirements).toHaveLength(28);
    expect(problem.requirements[0]).toEqual({
      date: '2026-02-01',
      shift: 'A',
      role: 'SUPERVISOR',
      requiredCount: 2,
    });
    expect(problem.requirements[27]).toEqual({
      date: '2026-02-28',
      shift: 'A',
      role: 'SUPERVISOR',
      requiredCount: 2,
    });
  });

  it('crosses multiple requirement rows with every day (2 rows × 3 days = 6 requirement entries)', () => {
    const problem = buildProblem({
      month: '2026-02',
      workers: [],
      requirements: [
        { role: 'SUPERVISOR', shift: 'A', requiredCount: 1 },
        { role: 'SCREENER', shift: 'B', requiredCount: 3 },
      ],
      availability: [],
    });

    // Only checking the count here (28 days × 2 rows) plus a couple of samples — full enumeration
    // is covered by the single-row test above.
    expect(problem.requirements).toHaveLength(56);
    expect(problem.requirements.filter((r) => r.role === 'SCREENER' && r.shift === 'B')).toHaveLength(
      28,
    );
    expect(
      problem.requirements.find((r) => r.date === '2026-02-15' && r.role === 'SCREENER'),
    ).toEqual({ date: '2026-02-15', shift: 'B', role: 'SCREENER', requiredCount: 3 });
  });
});

describe('parseSolverSolution — valid solver output', () => {
  it('round-trips a well-formed solution: one assignment, one unfillable_slot alert', () => {
    const rawStdout = JSON.stringify({
      assignments: [{ workerId: 7, date: '2026-07-01', shift: 'A' }],
      alerts: [
        { type: 'unfillable_slot', date: '2026-07-02', shift: 'B', role: 'SUPERVISOR', missing: 1 },
      ],
    });

    const solution = parseSolverSolution(rawStdout);

    expect(solution.assignments).toEqual([{ workerId: 7, date: '2026-07-01', shift: 'A' }]);
    expect(solution.alerts).toEqual([
      { type: 'unfillable_slot', date: '2026-07-02', shift: 'B', role: 'SUPERVISOR', missing: 1 },
    ]);
  });
});

describe('parseSolverSolution — malformed stdout is rejected, never treated as valid data', () => {
  it('throws on stdout that is not valid JSON at all', () => {
    expect(() => parseSolverSolution('{not: valid json')).toThrow();
  });
});
