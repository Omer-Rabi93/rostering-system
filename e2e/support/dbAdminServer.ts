// Standalone HTTP admin server used ONLY by the Playwright E2E suite to reset/reseed the
// dedicated E2E Postgres database between tests, and to arrange fixture preconditions (e.g.
// "worker X has zero availability rows this month") faster and more precisely than driving the
// whole thing through the UI.
//
// Deliberately NOT part of `apps/api/src` — this is test infrastructure, not application code.
// It reuses the exact same seed/reset code paths the rest of the repo already trusts
// (`apps/api/src/db/seed.ts`, `apps/api/src/db/seedData.ts`, `apps/api/tests/helpers/testDb.ts`)
// rather than re-implementing fixture logic, so the E2E fixture data never drifts from what
// earlier phases already proved correct.
//
// Started as one of Playwright's `webServer` entries (see `playwright.config.ts`), listening on
// `E2E_DB_ADMIN_PORT` (default 4100), talking to `DATABASE_URL` (the E2E-only test database — see
// `e2e/README` / playwright.config.ts comments for how that's kept separate from the developer's
// own `rostering-system-postgres-1` container).

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createPrismaClient } from '../../apps/api/src/db/client.js';
import { seedDatabase } from '../../apps/api/src/db/seed.js';
import { buildSeedAvailabilityRows, nextCalendarMonth, SEED_WORKERS } from '../../apps/api/src/db/seedData.js';
import { monthDays } from '../../apps/api/src/engine/calendar.js';
import { resetDatabase } from '../../apps/api/tests/helpers/testDb.js';

const PORT = Number(process.env.E2E_DB_ADMIN_PORT ?? 4100);
const prisma = createPrismaClient();

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Company-scoped rostering: `StaffingRequirement`/`Roster` fixture helpers below that used to
 * operate on a single GLOBAL matrix/roster now need a `companyId`. Every one of them defaults to
 * the lowest-`id` seeded company ("Alpha Security Ltd." -- the first entry in
 * `SEED_COMPANY_NAMES`), matching the frontend's own "default to the first company returned by
 * `GET /api/companies`" behavior (`RosterPage.tsx`/`RequirementsPage.tsx`), so these fixture calls
 * stay aimed at whichever company a test's UI assertions are actually looking at by default.
 */
async function getDefaultCompanyId(): Promise<number> {
  const company = await prisma.company.findFirst({ orderBy: { id: 'asc' } });
  if (!company) {
    throw new Error('getDefaultCompanyId: no company exists -- call /seed (or /reset-and-seed) first');
  }
  return company.id;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Seeds the default fixture, then returns a compact summary a Playwright fixture can hand
 * straight to a test: worker/company ids keyed by a stable name, plus the seeded availability
 * month, so tests never have to re-derive fixture identity themselves. */
async function doSeed() {
  const result = await seedDatabase(prisma);
  const workers = await prisma.worker.findMany({ include: { contract: true }, orderBy: { id: 'asc' } });
  const companies = await prisma.company.findMany({ orderBy: { id: 'asc' } });
  return {
    ...result,
    workers: workers.map((w) => ({
      id: w.id,
      nationalId: w.nationalId,
      name: w.name,
      companyId: w.companyId,
      role: w.role,
      status: w.status,
      shareToken: w.shareToken,
    })),
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
  };
}

/** "Fully available" helper called out explicitly by the Phase 11 setup-fixture amendment: sets
 * `ABC` on every date of `month` for the given worker ids (defaults to every seeded worker), so a
 * scenario that just needs assignments to exist can seed with one call instead of re-deriving the
 * weekly-pattern fixture logic itself. */
async function fillAvailability(month: string, workerIds: number[] | undefined, shifts: string) {
  const targetIds = workerIds ?? (await prisma.worker.findMany({ select: { id: true } })).map((w) => w.id);
  const dates = monthDays(month);
  await prisma.$transaction(
    targetIds.flatMap((workerId) =>
      dates.map((date) =>
        prisma.workerAvailability.upsert({
          where: { workerId_date: { workerId, date: toDate(date) } },
          create: { workerId, date: toDate(date), shifts },
          update: { shifts },
        }),
      ),
    ),
  );
  return { workerIds: targetIds, dates: dates.length };
}

async function clearAvailability(month: string, workerId: number) {
  const dates = monthDays(month);
  await prisma.workerAvailability.deleteMany({
    where: { workerId, date: { gte: toDate(dates[0] ?? `${month}-01`), lte: toDate(dates[dates.length - 1] ?? `${month}-01`) } },
  });
  return { workerId, cleared: dates.length };
}

async function clearAvailabilityForMonth(month: string) {
  const dates = monthDays(month);
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return { cleared: 0 };
  const result = await prisma.workerAvailability.deleteMany({
    where: { date: { gte: toDate(first), lte: toDate(last) } },
  });
  return { cleared: result.count };
}

async function setAvailabilityCell(workerId: number, date: string, shifts: string) {
  if (shifts.length === 0) {
    await prisma.workerAvailability.deleteMany({ where: { workerId, date: toDate(date) } });
    return { deleted: true };
  }
  await prisma.workerAvailability.upsert({
    where: { workerId_date: { workerId, date: toDate(date) } },
    create: { workerId, date: toDate(date), shifts },
    update: { shifts },
  });
  return { deleted: false };
}

async function deactivateAllWorkers() {
  const result = await prisma.worker.updateMany({ data: { status: 'INACTIVE' } });
  return { deactivated: result.count };
}

async function setWorkerStatus(workerId: number, status: 'ACTIVE' | 'INACTIVE') {
  await prisma.worker.update({ where: { id: workerId }, data: { status } });
  return { workerId, status };
}

/** Seeds availability rows built from the same weekly-pattern fixture intent as `seedData.ts`, but
 * for an arbitrary target month (used by the month-boundary scenarios, which need Feb/leap-Feb/30-
 * and 31-day months beyond the single "next calendar month" the default seed produces). */
async function seedAvailabilityForMonth(month: string) {
  const workers = await prisma.worker.findMany({ where: { status: 'ACTIVE' } });
  const byNationalId = new Map(SEED_WORKERS.map((w) => [w.nationalId, w]));
  let rows = 0;
  for (const worker of workers) {
    const fixture = byNationalId.get(worker.nationalId);
    if (!fixture) continue;
    const entries = buildSeedAvailabilityRows(fixture, month as never);
    for (const entry of entries) {
      await prisma.workerAvailability.upsert({
        where: { workerId_date: { workerId: worker.id, date: toDate(entry.date) } },
        create: { workerId: worker.id, date: toDate(entry.date), shifts: entry.shifts },
        update: { shifts: entry.shifts },
      });
      rows++;
    }
  }
  return { month, rows };
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('dbAdminServer error', err);
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && path === '/reset') {
    await resetDatabase(prisma);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && path === '/seed') {
    const result = await doSeed();
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/reset-and-seed') {
    await resetDatabase(prisma);
    const result = await doSeed();
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/availability/fill') {
    const body = (await readJsonBody(req)) as { month: string; workerIds?: number[]; shifts?: string };
    const result = await fillAvailability(body.month, body.workerIds, body.shifts ?? 'ABC');
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/availability/seed-month') {
    const body = (await readJsonBody(req)) as { month: string };
    const result = await seedAvailabilityForMonth(body.month);
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/availability/clear-worker') {
    const body = (await readJsonBody(req)) as { month: string; workerId: number };
    const result = await clearAvailability(body.month, body.workerId);
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/availability/clear-month') {
    const body = (await readJsonBody(req)) as { month: string };
    const result = await clearAvailabilityForMonth(body.month);
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/availability/set-cell') {
    const body = (await readJsonBody(req)) as { workerId: number; date: string; shifts: string };
    const result = await setAvailabilityCell(body.workerId, body.date, body.shifts);
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/workers/deactivate-all') {
    const result = await deactivateAllWorkers();
    send(res, 200, result);
    return;
  }

  if (req.method === 'POST' && path === '/workers/set-status') {
    const body = (await readJsonBody(req)) as { workerId: number; status: 'ACTIVE' | 'INACTIVE' };
    const result = await setWorkerStatus(body.workerId, body.status);
    send(res, 200, result);
    return;
  }

  if (req.method === 'GET' && path === '/next-calendar-month') {
    send(res, 200, { month: nextCalendarMonth() });
    return;
  }

  if (req.method === 'POST' && path === '/requirements/set-all-zero-except') {
    const body = (await readJsonBody(req)) as { role: string; shift: string; requiredCount: number };
    const companyId = await getDefaultCompanyId();
    await prisma.staffingRequirement.updateMany({ where: { companyId }, data: { requiredCount: 0 } });
    await prisma.staffingRequirement.update({
      where: { companyId_role_shift: { companyId, role: body.role as never, shift: body.shift as never } },
      data: { requiredCount: body.requiredCount },
    });
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && path === '/roster/assign') {
    // Directly inserts `ShiftWorker` rows bypassing `RosterValidator` — used ONLY as fixture setup
    // (e.g. "give this worker 23 pre-existing shifts so the 24th manual add is the one actually
    // under test"), never as the behavior under test itself, which always goes through the real
    // manual-edit API/UI.
    const body = (await readJsonBody(req)) as {
      month: string;
      workerId: number;
      role: string;
      shift: string;
      dates: string[];
    };
    const companyId = await getDefaultCompanyId();
    const roster = await prisma.roster.findUnique({ where: { companyId_month: { companyId, month: body.month } } });
    if (!roster) {
      send(res, 404, { error: `no roster for month ${body.month}` });
      return;
    }
    for (const date of body.dates) {
      const shift = await prisma.shift.findUnique({
        where: { rosterId_date_shiftType: { rosterId: roster.id, date: toDate(date), shiftType: body.shift as never } },
      });
      if (!shift) continue;
      await prisma.shiftWorker.upsert({
        where: { shiftId_workerId: { shiftId: shift.id, workerId: body.workerId } },
        create: { shiftId: shift.id, workerId: body.workerId, role: body.role as never },
        update: {},
      });
    }
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && path === '/requirements/set-all') {
    const body = (await readJsonBody(req)) as { requiredCount: number };
    const companyId = await getDefaultCompanyId();
    await prisma.staffingRequirement.updateMany({ where: { companyId }, data: { requiredCount: body.requiredCount } });
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && path === '/requirements/reset-default') {
    const defaults: Array<{ role: 'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER'; shift: 'A' | 'B' | 'C'; requiredCount: number }> = [];
    for (const role of ['GENERAL_GUARD', 'SUPERVISOR', 'SCREENER'] as const) {
      for (const shift of ['A', 'B', 'C'] as const) {
        defaults.push({ role, shift, requiredCount: role === 'GENERAL_GUARD' ? 3 : role === 'SUPERVISOR' ? 1 : 2 });
      }
    }
    const companyId = await getDefaultCompanyId();
    for (const row of defaults) {
      await prisma.staffingRequirement.update({
        where: { companyId_role_shift: { companyId, role: row.role, shift: row.shift } },
        data: { requiredCount: row.requiredCount },
      });
    }
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && path === '/workers/bulk-create') {
    // Fixture setup ONLY (payload-limit probe: needs ~100+ workers to push a dense availability
    // PUT body past 100kb) -- generates synthetic-but-checksum-valid national IDs starting at a
    // high prefix range that never collides with the 12 seeded fixture workers (prefixes 1-12).
    const body = (await readJsonBody(req)) as { count: number; companyId: number };
    const created: number[] = [];
    for (let i = 0; i < body.count; i++) {
      const prefix = 500_000 + i;
      let nationalId = '';
      for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
        const candidate = `${String(prefix).padStart(8, '0')}${checkDigit}`;
        // Reuse the same checksum algorithm every other national-ID fixture in this repo uses.
        let sum = 0;
        for (let d = 0; d < 9; d++) {
          const digit = Number(candidate[d]);
          const product = digit * (d % 2 === 0 ? 1 : 2);
          sum += product > 9 ? product - 9 : product;
        }
        if (sum % 10 === 0) {
          nationalId = candidate;
          break;
        }
      }
      const worker = await prisma.worker.create({
        data: {
          nationalId,
          name: `Bulk Worker ${i}`,
          companyId: body.companyId,
          role: 'GENERAL_GUARD',
          status: 'ACTIVE',
        },
      });
      await prisma.contract.create({
        data: { workerId: worker.id, hourlyCostIls: 40, minMonthlyHours: 0, maxMonthlyHours: 200 },
      });
      created.push(worker.id);
    }
    send(res, 200, { created });
    return;
  }

  if (req.method === 'GET' && path === '/workers') {
    const workers = await prisma.worker.findMany({ orderBy: { id: 'asc' } });
    send(
      res,
      200,
      workers.map((w) => ({
        id: w.id,
        nationalId: w.nationalId,
        name: w.name,
        companyId: w.companyId,
        role: w.role,
        status: w.status,
        shareToken: w.shareToken,
      })),
    );
    return;
  }

  send(res, 404, { error: 'not found' });
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`e2e db-admin server listening on :${PORT}`);
});
