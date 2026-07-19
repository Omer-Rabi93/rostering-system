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

  async function seedOneWorker(companyName = 'Shamir Security Ltd') {
    const company = await prisma.company.create({ data: { name: companyName } });
    const worker = await prisma.worker.create({
      data: {
        nationalId: validNationalId(400 + company.id),
        name: 'Dana Levi',
        role: 'GENERAL_GUARD',
        status: 'ACTIVE',
        companyId: company.id,
      },
    });
    await prisma.contract.create({
      data: { workerId: worker.id, hourlyCostIls: 45, minMonthlyHours: 0, maxMonthlyHours: 200 },
    });
    await prisma.staffingRequirement.create({
      data: { companyId: company.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 1 },
    });
    return { worker, company };
  }

  it('persists a draft roster with a shift slot for every day x shift-type, and the solver assignment', async () => {
    const { worker, company } = await seedOneWorker();
    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> =>
      Promise.resolve({
        assignments: problem.days.map((date) => ({ workerId: worker.id, date, shift: 'A' as const })),
        alerts: [],
      });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const result = await service.generate(company.id, '2027-02'); // Feb 2027, 28 days

    expect(result.alertCount).toBe(0);
    const roster = await prisma.roster.findUnique({ where: { id: result.rosterId } });
    expect(roster?.month).toBe('2027-02');
    expect(roster?.status).toBe('DRAFT');
    expect(roster?.companyId).toBe(company.id);

    const shifts = await prisma.shift.findMany({ where: { rosterId: result.rosterId }, include: { workers: true } });
    expect(shifts).toHaveLength(28 * 3); // every day, all 3 shift types get a slot

    const filledShiftA = shifts.filter((s) => s.shiftType === 'A');
    expect(filledShiftA.every((s) => s.workers.length === 1 && s.workers[0]?.workerId === worker.id)).toBe(true);
  });

  it('persists alerts translated from the solver vocabulary into DB AlertType + detail shape', async () => {
    const { worker, company } = await seedOneWorker();
    const fakeSolve = (): Promise<SolverSolution> =>
      Promise.resolve({
        assignments: [],
        alerts: [
          { type: 'unfillable_slot', date: '2027-02-01', shift: 'A', role: 'GENERAL_GUARD', missing: 1 },
          { type: 'min_hours_shortfall', workerId: worker.id, deficitHours: 40 },
        ],
      });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const result = await service.generate(company.id, '2027-02');
    expect(result.alertCount).toBe(2);

    const alerts = await prisma.alert.findMany({ where: { rosterId: result.rosterId }, orderBy: { id: 'asc' } });
    const [firstAlert, secondAlert] = alerts;
    if (!firstAlert || !secondAlert) throw new Error('expected exactly two alerts');
    expect(firstAlert.type).toBe('UNFILLABLE_SLOT');
    expect(firstAlert.detail).toEqual({ date: '2027-02-01', shift: 'A', role: 'GENERAL_GUARD' });
    expect(secondAlert.type).toBe('MIN_HOURS_SHORTFALL');
    expect(secondAlert.detail).toEqual({ workerId: worker.id, deficitHours: 40 });
  });

  it('is idempotent on retry: calling generate() twice for the same company+month never duplicates shifts', async () => {
    const { worker, company } = await seedOneWorker();
    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> => {
      const [firstDay] = problem.days;
      if (!firstDay) throw new Error('expected at least one day in the problem');
      return Promise.resolve({ assignments: [{ workerId: worker.id, date: firstDay, shift: 'A' as const }], alerts: [] });
    };
    const service = new RosterGenerationService(prisma, fakeSolve);

    const first = await service.generate(company.id, '2027-02');
    const second = await service.generate(company.id, '2027-02');

    expect(second.rosterId).toBe(first.rosterId); // same roster row (upsert by unique (companyId, month)), not a duplicate
    const rosters = await prisma.roster.findMany({ where: { companyId: company.id, month: '2027-02' } });
    expect(rosters).toHaveLength(1);

    const shifts = await prisma.shift.findMany({ where: { rosterId: first.rosterId } });
    expect(shifts).toHaveLength(28 * 3); // not doubled
  });

  it('rolls back the entire transaction on a mid-persist failure, then a subsequent retry converges cleanly', async () => {
    const { worker, company } = await seedOneWorker();
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

    await expect(service.generate(company.id, '2027-02')).rejects.toThrow();

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
    const result = await retryService.generate(company.id, '2027-02');

    const rosters = await prisma.roster.findMany({ where: { companyId: company.id, month: '2027-02' } });
    expect(rosters).toHaveLength(1);
    const shifts = await prisma.shift.findMany({ where: { rosterId: result.rosterId } });
    expect(shifts).toHaveLength(28 * 3);
  });

  it('reopens an already-published month as a draft (status flips back)', async () => {
    const { company } = await seedOneWorker();
    const fakeSolve = (): Promise<SolverSolution> => Promise.resolve({ assignments: [], alerts: [] });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const first = await service.generate(company.id, '2027-02');
    await prisma.roster.update({ where: { id: first.rosterId }, data: { status: 'PUBLISHED', publishedAt: new Date() } });

    const second = await service.generate(company.id, '2027-02');
    expect(second.rosterId).toBe(first.rosterId);

    const roster = await prisma.roster.findUnique({ where: { id: second.rosterId } });
    expect(roster?.status).toBe('DRAFT');
  });

  it('two companies each auto-generate a roster independently for the same month, with no cross-company worker leakage into the candidate pool, and neither clobbers the other', async () => {
    const { worker: workerA, company: companyA } = await seedOneWorker('Alpha Security Ltd');
    const { worker: workerB, company: companyB } = await seedOneWorker('Beta Guarding Co');

    // The solver echoes back whichever workers `buildProblem` actually handed it -- if company B's
    // worker ever leaked into company A's candidate pool (or vice versa), this fake would be able
    // to "assign" them and the assertions below would catch it.
    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> =>
      Promise.resolve({
        assignments: problem.days.flatMap((date) =>
          problem.workers.map((w) => ({ workerId: w.id, date, shift: 'A' as const })),
        ),
        alerts: [],
      });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const resultA = await service.generate(companyA.id, '2027-05');
    const resultB = await service.generate(companyB.id, '2027-05');

    expect(resultA.rosterId).not.toBe(resultB.rosterId);

    const rosterA = await prisma.roster.findUniqueOrThrow({ where: { id: resultA.rosterId } });
    const rosterB = await prisma.roster.findUniqueOrThrow({ where: { id: resultB.rosterId } });
    expect(rosterA.companyId).toBe(companyA.id);
    expect(rosterB.companyId).toBe(companyB.id);
    expect(rosterA.month).toBe('2027-05');
    expect(rosterB.month).toBe('2027-05'); // same month, both rosters coexist

    const shiftWorkersA = await prisma.shiftWorker.findMany({ where: { shift: { rosterId: resultA.rosterId } } });
    const shiftWorkersB = await prisma.shiftWorker.findMany({ where: { shift: { rosterId: resultB.rosterId } } });
    expect(shiftWorkersA.every((sw) => sw.workerId === workerA.id)).toBe(true);
    expect(shiftWorkersB.every((sw) => sw.workerId === workerB.id)).toBe(true);

    // Generating company B's roster did not touch company A's roster (still 3 shift assignments
    // for worker A -- one per day of the month it was seeded to work Shift A, not zeroed out).
    expect(shiftWorkersA.length).toBeGreaterThan(0);
    expect(shiftWorkersB.length).toBeGreaterThan(0);
  });

  it('end-to-end: runs the real CP-SAT solver process and persists its output', async () => {
    const { worker, company } = await seedOneWorker();
    // Availability v3: seed the worker with a `WorkerAvailability` row EXCLUDING shifts B and C on
    // every date of the target month, so the worker is available for shift A only (the same
    // real-world scenario the pre-Availability-v3 `shifts: 'A'` (included-shifts) row expressed) --
    // this fixture must still get assigned.
    const days = monthDays('2026-02');
    await prisma.workerAvailability.createMany({
      data: days.map((date) => ({
        workerId: worker.id,
        date: new Date(`${date}T00:00:00.000Z`),
        excludedShifts: 'BC',
      })),
    });
    const service = new RosterGenerationService(prisma, undefined, { pythonExecutable: VENV_PYTHON });

    const result = await service.generate(company.id, '2026-02'); // small month, single worker/requirement fixture

    expect(result.rosterId).toEqual(expect.any(Number));
    const shiftWorkers = await prisma.shiftWorker.findMany({ where: { workerId: worker.id } });
    expect(shiftWorkers.length).toBeGreaterThan(0);
  }, 40_000);

  it('end-to-end: a worker excluded from every shift all month is never assigned by the real solver', async () => {
    const { worker, company } = await seedOneWorker(); // ACTIVE, contract present
    // Availability v3: absence of a `WorkerAvailability` row now means available for everything, so
    // "never assigned" must be expressed with an explicit full-exclusion (`excludedShifts: 'ABC'`)
    // row for every date of the month -- the new way to express what zero rows used to mean.
    const days = monthDays('2026-02');
    await prisma.workerAvailability.createMany({
      data: days.map((date) => ({
        workerId: worker.id,
        date: new Date(`${date}T00:00:00.000Z`),
        excludedShifts: 'ABC',
      })),
    });
    const service = new RosterGenerationService(prisma, undefined, { pythonExecutable: VENV_PYTHON });

    const result = await service.generate(company.id, '2026-02');

    const shiftWorkers = await prisma.shiftWorker.findMany({ where: { workerId: worker.id } });
    expect(shiftWorkers).toHaveLength(0);
    // The one seeded staffing requirement (GENERAL_GUARD/A, requiredCount 1) can never be met ->
    // an unfillable_slot alert for every day of the month.
    expect(result.alertCount).toBeGreaterThan(0);
    const alerts = await prisma.alert.findMany({ where: { rosterId: result.rosterId } });
    expect(alerts.every((a) => a.type === 'UNFILLABLE_SLOT')).toBe(true);
  }, 40_000);

  it('v4 eligibility: a never-synced worker (lastImportTaskId null) is included regardless of the company\'s ImportTask history', async () => {
    const { worker, company } = await seedOneWorker();
    // Company has a completed WORKFORCE_SYNC task in its history, but this worker was never
    // touched by it (created/managed by hand) -- `lastImportTaskId` stays null.
    await prisma.importTask.create({
      data: { companyId: company.id, kind: 'WORKFORCE_SYNC', status: 'COMPLETED', month: '2027-02', finishedAt: new Date() },
    });
    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> =>
      Promise.resolve({
        assignments: problem.days.map((date) => ({ workerId: worker.id, date, shift: 'A' as const })),
        alerts: [],
      });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const result = await service.generate(company.id, '2027-02');

    const shiftWorkers = await prisma.shiftWorker.findMany({ where: { shift: { rosterId: result.rosterId } } });
    expect(shiftWorkers.length).toBeGreaterThan(0);
    expect(shiftWorkers.every((sw) => sw.workerId === worker.id)).toBe(true);
  });

  it('v4 eligibility: a worker whose lastImportTaskId matches the latest COMPLETED WORKFORCE_SYNC task is included', async () => {
    const { worker, company } = await seedOneWorker();
    const latestTask = await prisma.importTask.create({
      data: { companyId: company.id, kind: 'WORKFORCE_SYNC', status: 'COMPLETED', month: '2027-02', finishedAt: new Date() },
    });
    await prisma.worker.update({ where: { id: worker.id }, data: { lastImportTaskId: latestTask.id } });

    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> =>
      Promise.resolve({
        assignments: problem.days.map((date) => ({ workerId: worker.id, date, shift: 'A' as const })),
        alerts: [],
      });
    const service = new RosterGenerationService(prisma, fakeSolve);

    const result = await service.generate(company.id, '2027-02');

    const shiftWorkers = await prisma.shiftWorker.findMany({ where: { shift: { rosterId: result.rosterId } } });
    expect(shiftWorkers.length).toBeGreaterThan(0);
    expect(shiftWorkers.every((sw) => sw.workerId === worker.id)).toBe(true);
  });

  it('v4 eligibility: an ACTIVE worker whose lastImportTaskId points at a stale/non-latest task (older COMPLETED, or CANCELLED/FAILED) is excluded from the candidate pool', async () => {
    const { worker, company } = await seedOneWorker();

    // An older COMPLETED WORKFORCE_SYNC task the worker was stamped with...
    const olderCompletedTask = await prisma.importTask.create({
      data: {
        companyId: company.id,
        kind: 'WORKFORCE_SYNC',
        status: 'COMPLETED',
        month: '2027-02',
        finishedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    // ...followed by a newer COMPLETED WORKFORCE_SYNC task that did NOT touch this worker (e.g.
    // they were dropped from the latest uploaded CSV) -- this is now "the latest completed sync".
    await prisma.importTask.create({
      data: {
        companyId: company.id,
        kind: 'WORKFORCE_SYNC',
        status: 'COMPLETED',
        month: '2027-02',
        finishedAt: new Date('2020-06-01T00:00:00.000Z'),
      },
    });
    await prisma.worker.update({ where: { id: worker.id }, data: { lastImportTaskId: olderCompletedTask.id } });

    // The fake solve directly inspects the candidate pool `buildProblem` handed it (same technique
    // the cross-company-isolation test above uses) -- if the excluded worker ever leaked into the
    // pool, this would echo an assignment for them and the assertions below would catch it.
    let observedWorkerIds: readonly number[] = [];
    const fakeSolve = (problem: SolverProblem): Promise<SolverSolution> => {
      observedWorkerIds = problem.workers.map((w) => w.id);
      return Promise.resolve({
        assignments: problem.workers.flatMap((w) => problem.days.map((date) => ({ workerId: w.id, date, shift: 'A' as const }))),
        alerts: [],
      });
    };
    const service = new RosterGenerationService(prisma, fakeSolve);

    const result = await service.generate(company.id, '2027-02');

    // Worker is still ACTIVE (stays active, per the redesign -- deactivation sweep removed)...
    const persistedWorker = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(persistedWorker.status).toBe('ACTIVE');
    // ...but excluded from the solver's candidate pool entirely -> never assigned.
    expect(observedWorkerIds).not.toContain(worker.id);
    expect(observedWorkerIds).toHaveLength(0);
    const shiftWorkers = await prisma.shiftWorker.findMany({ where: { shift: { rosterId: result.rosterId } } });
    expect(shiftWorkers).toHaveLength(0);

    // Same exclusion holds for a worker stamped against a CANCELLED task (superseded upload).
    const { worker: cancelledWorker, company: cancelledCompany } = await seedOneWorker('Cancelled Co');
    const cancelledTask = await prisma.importTask.create({
      data: { companyId: cancelledCompany.id, kind: 'WORKFORCE_SYNC', status: 'CANCELLED', month: '2027-02' },
    });
    await prisma.worker.update({
      where: { id: cancelledWorker.id },
      data: { lastImportTaskId: cancelledTask.id },
    });
    const resultForCancelled = await service.generate(cancelledCompany.id, '2027-02');
    const shiftWorkersForCancelled = await prisma.shiftWorker.findMany({
      where: { shift: { rosterId: resultForCancelled.rosterId } },
    });
    expect(shiftWorkersForCancelled).toHaveLength(0);
  });

  it('end-to-end: a month where EVERY active worker is excluded from every shift generates an all-alerts empty roster', async () => {
    // Two active workers with contracts and a staffing requirement, but every one of them is
    // excluded from every shift, every date this month (Availability v3: this is now how "nobody
    // is available" is expressed -- zero rows would instead mean "available for everything") --
    // distinct from "empty workforce" (no active workers at all): here the workforce and
    // requirements are non-empty, only availability is (fully excluded).
    const company = await prisma.company.create({ data: { name: 'Shamir Security Ltd' } });
    const days = monthDays('2026-02');
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
      await prisma.workerAvailability.createMany({
        data: days.map((date) => ({
          workerId: worker.id,
          date: new Date(`${date}T00:00:00.000Z`),
          excludedShifts: 'ABC',
        })),
      });
    }
    await prisma.staffingRequirement.create({
      data: { companyId: company.id, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 1 },
    });
    const service = new RosterGenerationService(prisma, undefined, { pythonExecutable: VENV_PYTHON });

    const result = await service.generate(company.id, '2026-02');

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
