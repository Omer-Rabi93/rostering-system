import type { PrismaClient } from './client.js';
import { buildSeedAvailabilityRows, nextCalendarMonth, SEED_COMPANY_NAMES, SEED_STAFFING_REQUIREMENTS, SEED_WORKERS } from './seedData.js';

export interface SeedResult {
  companies: number;
  workers: number;
  contracts: number;
  staffingRequirements: number;
  /** `WorkerAvailability` rows seeded for `availabilityMonth` (Availability v2). */
  availabilityRows: number;
  /** The `YYYY-MM` month the availability rows above were seeded for (always "next calendar
   * month" relative to when the seed ran — see `seedData.ts#nextCalendarMonth`). */
  availabilityMonth: string;
}

/**
 * Idempotent seed: 3 companies, ≥10 workers with contracts, the default staffing requirements
 * (one row per role × shift), and — Availability v2 — one month's worth of `WorkerAvailability`
 * rows per fixture worker for the calendar month after the one the seed runs in. Safe to run
 * against an already-seeded database — existing rows (matched by the same uniqueness rules the
 * schema enforces: company name, worker nationalId, one contract per worker, one requirement per
 * role×shift, one availability row per worker×date) are left untouched rather than duplicated.
 */
export async function seedDatabase(prisma: PrismaClient): Promise<SeedResult> {
  const companyIdByName = new Map<string, number>();
  const availabilityMonth = nextCalendarMonth();

  for (const name of SEED_COMPANY_NAMES) {
    const existing = await prisma.company.findFirst({ where: { name } });
    const company = existing ?? (await prisma.company.create({ data: { name } }));
    companyIdByName.set(name, company.id);
  }

  let workersCreated = 0;
  let contractsCreated = 0;
  let availabilityRowsCreated = 0;

  for (const seedWorker of SEED_WORKERS) {
    const companyId = companyIdByName.get(seedWorker.companyName);
    if (companyId === undefined) {
      throw new Error(`Seed data error: unknown company "${seedWorker.companyName}"`);
    }

    const existingWorker = await prisma.worker.findUnique({
      where: { nationalId: seedWorker.nationalId },
    });
    const worker =
      existingWorker ??
      (await prisma.worker.create({
        data: {
          nationalId: seedWorker.nationalId,
          name: seedWorker.name,
          companyId,
          role: seedWorker.role,
          status: seedWorker.status,
        },
      }));
    if (!existingWorker) {
      workersCreated++;
    }

    const existingContract = await prisma.contract.findUnique({
      where: { workerId: worker.id },
    });
    if (!existingContract) {
      await prisma.contract.create({
        data: {
          workerId: worker.id,
          hourlyCostIls: seedWorker.hourlyCostIls,
          minMonthlyHours: seedWorker.minMonthlyHours,
          maxMonthlyHours: seedWorker.maxMonthlyHours,
        },
      });
      contractsCreated++;
    }

    // Availability v2: one `WorkerAvailability` row per (worker, date) for `availabilityMonth`,
    // derived from the fixture's old weekly-matrix intent (see `buildSeedAvailabilityRows`).
    // Matches the existence-check-then-write idempotency pattern used above for company/worker/
    // contract, rather than a blind `upsert`, so re-runs report an accurate `availabilityRows` count.
    for (const row of buildSeedAvailabilityRows(seedWorker, availabilityMonth)) {
      const date = new Date(`${row.date}T00:00:00.000Z`);
      const existingRow = await prisma.workerAvailability.findUnique({
        where: { workerId_date: { workerId: worker.id, date } },
      });
      if (!existingRow) {
        await prisma.workerAvailability.create({ data: { workerId: worker.id, date, shifts: row.shifts } });
        availabilityRowsCreated++;
      }
    }
  }

  // Company-scoped rostering: the default staffing-requirements matrix is seeded independently
  // for EVERY company (not once globally) — each company gets its own full role×shift matrix, so
  // no company is silently left with an empty requirements set after seeding.
  let staffingRequirementsCreated = 0;
  for (const companyId of companyIdByName.values()) {
    for (const requirement of SEED_STAFFING_REQUIREMENTS) {
      const existing = await prisma.staffingRequirement.findFirst({
        where: { companyId, role: requirement.role, shift: requirement.shift },
      });
      if (!existing) {
        await prisma.staffingRequirement.create({ data: { ...requirement, companyId } });
        staffingRequirementsCreated++;
      }
    }
  }

  return {
    companies: companyIdByName.size,
    workers: workersCreated,
    contracts: contractsCreated,
    staffingRequirements: staffingRequirementsCreated,
    availabilityRows: availabilityRowsCreated,
    availabilityMonth,
  };
}
