import { test as base, expect } from '@playwright/test';

import { E2E_DB_ADMIN_URL } from '../../playwright.config.js';

export interface SeedWorker {
  readonly id: number;
  readonly nationalId: string;
  readonly name: string;
  readonly companyId: number;
  readonly role: 'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER';
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly shareToken: string;
}

export interface SeedCompany {
  readonly id: number;
  readonly name: string;
}

export interface SeedResult {
  readonly companies: readonly SeedCompany[];
  readonly workers: readonly SeedWorker[];
  readonly staffingRequirements: number;
  readonly availabilityRows: number;
  readonly availabilityMonth: string;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`dbAdmin ${url} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/**
 * Thin client for `e2e/support/dbAdminServer.ts` — every method is a direct-to-Postgres fixture
 * arrangement (bypassing the UI/API on purpose, since these calls are test SETUP, not the thing
 * under test) used to get a test into its starting state quickly and precisely.
 */
export class DbAdmin {
  constructor(private readonly baseUrl: string) {}

  reset(): Promise<{ ok: true }> {
    return postJson(`${this.baseUrl}/reset`);
  }

  seed(): Promise<SeedResult> {
    return postJson(`${this.baseUrl}/seed`);
  }

  resetAndSeed(): Promise<SeedResult> {
    return postJson(`${this.baseUrl}/reset-and-seed`);
  }

  /** Sets `shifts` (default `"ABC"`) on every date of `month` for `workerIds` (default: every
   * worker) — the "fully available" helper the Phase 11 setup-fixture amendment calls for. */
  fillAvailability(args: { month: string; workerIds?: number[]; shifts?: string }): Promise<{ workerIds: number[]; dates: number }> {
    return postJson(`${this.baseUrl}/availability/fill`, args);
  }

  /** Seeds availability rows for an arbitrary month using each fixture worker's original
   * weekly-pattern intent (for month-boundary scenarios beyond the default seeded month). */
  seedAvailabilityForMonth(month: string): Promise<{ month: string; rows: number }> {
    return postJson(`${this.baseUrl}/availability/seed-month`, { month });
  }

  clearWorkerAvailability(args: { month: string; workerId: number }): Promise<{ workerId: number; cleared: number }> {
    return postJson(`${this.baseUrl}/availability/clear-worker`, args);
  }

  clearMonthAvailability(args: { month: string }): Promise<{ cleared: number }> {
    return postJson(`${this.baseUrl}/availability/clear-month`, args);
  }

  setAvailabilityCell(args: { workerId: number; date: string; shifts: string }): Promise<{ deleted: boolean }> {
    return postJson(`${this.baseUrl}/availability/set-cell`, args);
  }

  deactivateAllWorkers(): Promise<{ deactivated: number }> {
    return postJson(`${this.baseUrl}/workers/deactivate-all`);
  }

  setWorkerStatus(args: { workerId: number; status: 'ACTIVE' | 'INACTIVE' }): Promise<{ workerId: number; status: string }> {
    return postJson(`${this.baseUrl}/workers/set-status`, args);
  }

  bulkCreateWorkers(args: { count: number; companyId: number }): Promise<{ created: number[] }> {
    return postJson(`${this.baseUrl}/workers/bulk-create`, args);
  }

  async listWorkers(): Promise<SeedWorker[]> {
    const res = await fetch(`${this.baseUrl}/workers`);
    if (!res.ok) throw new Error(`dbAdmin /workers failed: ${res.status}`);
    return (await res.json()) as SeedWorker[];
  }

  /** Zeroes every staffing-requirement cell except the one given, bounding how many
   * unfillable-slot alerts a subsequent generation can produce (useful for alert-gate scenarios
   * that need "some alerts, not hundreds"). */
  setSingleRequirement(args: { role: string; shift: string; requiredCount: number }): Promise<{ ok: true }> {
    return postJson(`${this.baseUrl}/requirements/set-all-zero-except`, args);
  }

  /** Directly inserts `ShiftWorker` rows for an existing generated roster, bypassing
   * `RosterValidator` — fixture setup only (e.g. pre-loading a worker to just under a contract
   * hour boundary), never the behavior under test. */
  assignShifts(args: { month: string; workerId: number; role: string; shift: string; dates: string[] }): Promise<{ ok: true }> {
    return postJson(`${this.baseUrl}/roster/assign`, args);
  }

  setAllRequirements(requiredCount: number): Promise<{ ok: true }> {
    return postJson(`${this.baseUrl}/requirements/set-all`, { requiredCount });
  }

  resetRequirementsToDefault(): Promise<{ ok: true }> {
    return postJson(`${this.baseUrl}/requirements/reset-default`);
  }

  async findWorkerByNationalId(nationalId: string): Promise<SeedWorker> {
    const workers = await this.listWorkers();
    const worker = workers.find((w) => w.nationalId === nationalId);
    if (!worker) throw new Error(`No worker with nationalId ${nationalId}`);
    return worker;
  }
}

export function findWorker(seed: SeedResult, name: string): SeedWorker {
  const worker = seed.workers.find((w) => w.name === name);
  if (!worker) throw new Error(`Seed fixture has no worker named "${name}"`);
  return worker;
}

export function findCompany(seed: SeedResult, name: string): SeedCompany {
  const company = seed.companies.find((c) => c.name === name);
  if (!company) throw new Error(`Seed fixture has no company named "${name}"`);
  return company;
}

interface Fixtures {
  dbAdmin: DbAdmin;
  /** Auto-runs before every test: truncates every table and reseeds the default fixture (3
   * companies, 12 workers with contracts, a full 9-row role×shift staffing-requirements matrix
   * PER company -- company-scoped rostering, so 27 rows total -- and a month's worth of
   * `WorkerAvailability` rows for `availabilityMonth`), giving every single test an independent,
   * repeatable starting database without a per-file `beforeEach` boilerplate line. */
  seed: SeedResult;
}

export const test = base.extend<Fixtures>({
  dbAdmin: async ({}, use) => {
    await use(new DbAdmin(E2E_DB_ADMIN_URL));
  },
  seed: [
    async ({ dbAdmin }, use) => {
      const result = await dbAdmin.resetAndSeed();
      await use(result);
    },
    { auto: true },
  ],
});

export { expect };
