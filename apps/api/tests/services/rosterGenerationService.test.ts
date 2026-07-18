import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';
import type { SolverProblem, SolverSolution } from '../../src/engine/problem.js';

import { monthDays } from '../../src/engine/calendar.js';
import { RosterGenerationService } from '../../src/services/rosterGenerationService.js';
import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(currentDir, '../../../..');
const VENV_PYTHON = path.resolve(REPO_ROOT, 'solver/.venv/bin/python3');

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

describe('RosterGenerationService.generate', () => {
  const prisma = getTestPrismaClient();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  async function seedOneWorker() {
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    const worker = await prisma.worker.create({
      data: {
        nationalId: validNationalId(401),
        name: 'Dana Levi',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      },
    });
    await prisma.contract.create({
      data: { workerId: worker.id, hourlyCostIls: 45, minMonthlyHours: 0, maxMonthlyHours: 200 },
    });
    await prisma.staffingRequirement.create({ data: { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 1 } });
    return worker;
  }

  it('persists a draft roster with a shift slot for every day x shift-type, and the solver assignment', async () => {
    const worker = await seedOneWorker();
    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> =>
      Promise.resolve({
        assignments: problem.days.map((date) => ({ workerId: worker.id, date, shift: 'A' as const })),
        alerts: [],
      });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const result = await service.generate('2027-02'); // Feb 2027, 28 days

    expect(result.alertCount).toBe(0);
    const roster = await prisma.roster.findUnique({ where: { id: result.rosterId } });
    expect(roster?.month).toBe('2027-02');
    expect(roster?.status).toBe('DRAFT');

    const shifts = await prisma.shift.findMany({ where: { rosterId: result.rosterId }, include: { workers: true } });
    expect(shifts).toHaveLength(28 * 3); // every day, all 3 shift types get a slot

    const filledShiftA = shifts.filter((s) => s.shiftType === 'A');
    expect(filledShiftA.every((s) => s.workers.length === 1 && s.workers[0]?.workerId === worker.id)).toBe(true);
  });

  it('persists alerts translated from the solver vocabulary into DB AlertType + detail shape', async () => {
    const worker = await seedOneWorker();
    const fakeSolve = (): Promise<SolverSolution> =>
      Promise.resolve({
        assignments: [],
        alerts: [
          { type: 'unfillable_slot', date: '2027-02-01', shift: 'A', role: 'GENERAL_GUARD', missing: 1 },
          { type: 'min_hours_shortfall', workerId: worker.id, deficitHours: 40 },
        ],
      });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const result = await service.generate('2027-02');
    expect(result.alertCount).toBe(2);

    const alerts = await prisma.alert.findMany({ where: { rosterId: result.rosterId }, orderBy: { id: 'asc' } });
    const [firstAlert, secondAlert] = alerts;
    if (!firstAlert || !secondAlert) throw new Error('expected exactly two alerts');
    expect(firstAlert.type).toBe('UNFILLABLE_SLOT');
    expect(firstAlert.detail).toEqual({ date: '2027-02-01', shift: 'A', role: 'GENERAL_GUARD' });
    expect(secondAlert.type).toBe('MIN_HOURS_SHORTFALL');
    expect(secondAlert.detail).toEqual({ workerId: worker.id, deficitHours: 40 });
  });

  it('is idempotent on retry: calling generate() twice for the same month never duplicates shifts', async () => {
    const worker = await seedOneWorker();
    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> => {
      const [firstDay] = problem.days;
      if (!firstDay) throw new Error('expected at least one day in the problem');
      return Promise.resolve({ assignments: [{ workerId: worker.id, date: firstDay, shift: 'A' as const }], alerts: [] });
    };
    const service = new RosterGenerationService(prisma, fakeSolve);

    const first = await service.generate('2027-02');
    const second = await service.generate('2027-02');

    expect(second.rosterId).toBe(first.rosterId); // same roster row (upsert by unique month), not a duplicate
    const rosters = await prisma.roster.findMany({ where: { month: '2027-02' } });
    expect(rosters).toHaveLength(1);

    const shifts = await prisma.shift.findMany({ where: { rosterId: first.rosterId } });
    expect(shifts).toHaveLength(28 * 3); // not doubled
  });

  it('rolls back the entire transaction on a mid-persist failure, then a subsequent retry converges cleanly', async () => {
    const worker = await seedOneWorker();
    const NON_EXISTENT_WORKER_ID = worker.id + 999_999;
    const brokenSolve = (problem: SolverProblem): Promise<SolverSolution> => {
      const [firstDay] = problem.days;
      if (!firstDay) throw new Error('expected at least one day in the problem');
      // References a worker id that does not exist -> the shiftWorker FK constraint fails partway
      // through persistence, forcing a rollback of the whole one-transaction delete-and-rewrite.
      return Promise.resolve({
        assignments: [{ workerId: NON_EXISTENT_WORKER_ID, date: firstDay, shift: 'A' as const }],
        alerts: [],
      });
    };
    const service = new RosterGenerationService(prisma, brokenSolve);

    await expect(service.generate('2027-02')).rejects.toThrow();

    // Nothing was left half-written: no roster row lingers with orphaned/partial shifts.
    const shiftsAfterFailure = await prisma.shift.findMany({});
    expect(shiftsAfterFailure).toHaveLength(0);

    // A subsequent (successful) retry -- simulating pg-boss's retryLimit -- converges cleanly.
    const goodSolve = (problem: SolverProblem): Promise<SolverSolution> => {
      const [firstDay] = problem.days;
      if (!firstDay) throw new Error('expected at least one day in the problem');
      return Promise.resolve({ assignments: [{ workerId: worker.id, date: firstDay, shift: 'A' as const }], alerts: [] });
    };
    const retryService = new RosterGenerationService(prisma, goodSolve);
    const result = await retryService.generate('2027-02');

    const rosters = await prisma.roster.findMany({ where: { month: '2027-02' } });
    expect(rosters).toHaveLength(1);
    const shifts = await prisma.shift.findMany({ where: { rosterId: result.rosterId } });
    expect(shifts).toHaveLength(28 * 3);
  });

  it('reopens an already-published month as a draft (status flips back)', async () => {
    await seedOneWorker();
    const fakeSolve = (): Promise<SolverSolution> => Promise.resolve({ assignments: [], alerts: [] });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const first = await service.generate('2027-02');
    await prisma.roster.update({ where: { id: first.rosterId }, data: { status: 'PUBLISHED', publishedAt: new Date() } });

    const second = await service.generate('2027-02');
    expect(second.rosterId).toBe(first.rosterId);

    const roster = await prisma.roster.findUnique({ where: { id: second.rosterId } });
    expect(roster?.status).toBe('DRAFT');
  });

  it('end-to-end: runs the real CP-SAT solver process and persists its output', async () => {
    const worker = await seedOneWorker();
    // Availability v2: the real solver only ever assigns a worker to a (date, shift) it has a
    // `WorkerAvailability` row for -- seed the worker as available for shift A on every date of
    // the target month so this fixture still gets assigned (mirrors the pre-Phase-V4 "fully
    // available" default this service used to fabricate itself).
    const days = monthDays('2026-02');
    await prisma.workerAvailability.createMany({
      data: days.map((date) => ({ workerId: worker.id, date: new Date(`${date}T00:00:00.000Z`), shifts: 'A' })),
    });
    const service = new RosterGenerationService(prisma, undefined, { pythonExecutable: VENV_PYTHON });

    const result = await service.generate('2026-02'); // small month, single worker/requirement fixture

    expect(result.rosterId).toEqual(expect.any(Number));
    const shiftWorkers = await prisma.shiftWorker.findMany({ where: { workerId: worker.id } });
    expect(shiftWorkers.length).toBeGreaterThan(0);
  }, 40_000);

  it('end-to-end: a worker with zero availability rows for the month is never assigned by the real solver', async () => {
    const worker = await seedOneWorker(); // ACTIVE, contract present, but NO WorkerAvailability rows seeded
    const service = new RosterGenerationService(prisma, undefined, { pythonExecutable: VENV_PYTHON });

    const result = await service.generate('2026-02');

    const shiftWorkers = await prisma.shiftWorker.findMany({ where: { workerId: worker.id } });
    expect(shiftWorkers).toHaveLength(0);
    // The one seeded staffing requirement (GENERAL_GUARD/A, requiredCount 1) can never be met ->
    // an unfillable_slot alert for every day of the month.
    expect(result.alertCount).toBeGreaterThan(0);
    const alerts = await prisma.alert.findMany({ where: { rosterId: result.rosterId } });
    expect(alerts.every((a) => a.type === 'UNFILLABLE_SLOT')).toBe(true);
  }, 40_000);

  it('end-to-end: a month with zero availability rows for ANY active worker generates an all-alerts empty roster', async () => {
    // Two active workers with contracts and a staffing requirement, but nobody has a single
    // `WorkerAvailability` row this month -- distinct from "empty workforce" (no active workers at
    // all): here the workforce and requirements are non-empty, only availability is empty.
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    for (const prefix of [402, 403]) {
      const worker = await prisma.worker.create({
        data: {
          nationalId: validNationalId(prefix),
          name: `Worker ${prefix}`,
          role: 'GENERAL_GUARD',
          status: 'ACTIVE',
          companyId: company.id,
        },
      });
      await prisma.contract.create({
        data: { workerId: worker.id, hourlyCostIls: 45, minMonthlyHours: 0, maxMonthlyHours: 200 },
      });
    }
    await prisma.staffingRequirement.create({ data: { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 1 } });
    const service = new RosterGenerationService(prisma, undefined, { pythonExecutable: VENV_PYTHON });

    const result = await service.generate('2026-02');

    const roster = await prisma.roster.findUnique({ where: { id: result.rosterId } });
    expect(roster?.status).toBe('DRAFT'); // reaches a terminal, persisted state -- no crash

    const shiftWorkers = await prisma.shiftWorker.findMany({});
    expect(shiftWorkers).toHaveLength(0); // nobody assigned anywhere

    expect(result.alertCount).toBeGreaterThan(0);
    const alerts = await prisma.alert.findMany({ where: { rosterId: result.rosterId } });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a.type === 'UNFILLABLE_SLOT')).toBe(true);

    const shifts = await prisma.shift.findMany({ where: { rosterId: result.rosterId } });
    expect(shifts).toHaveLength(28 * 3); // the empty calendar grid still renders (every slot exists)
  }, 40_000);
});
