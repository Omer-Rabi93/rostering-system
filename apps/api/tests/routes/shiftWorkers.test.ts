import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidIsraeliId } from '@rostering/shared';

import { disconnectTestPrismaClient, getTestPrismaClient, resetDatabase } from '../helpers/testDb.js';
import { buildTestApp } from '../helpers/testApp.js';

function validNationalId(prefix: number): string {
  const base = String(prefix).padStart(8, '0');
  for (let checkDigit = 0; checkDigit <= 9; checkDigit++) {
    const candidate = `${base}${checkDigit}`;
    if (isValidIsraeliId(candidate)) return candidate;
  }
  throw new Error('no valid check digit found');
}

describe('/api/shifts/:shiftId/workers', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  async function makeWorker(
    prefix: number,
    overrides: {
      minMonthlyHours?: number;
      maxMonthlyHours?: number;
      role?: 'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER';
      status?: 'ACTIVE' | 'INACTIVE';
    } = {},
  ) {
    const company = await prisma.company.create({ data: { name: `Company ${prefix}` } });
    const worker = await prisma.worker.create({
      data: {
        nationalId: validNationalId(prefix),
        name: `Worker ${prefix}`,
        role: overrides.role ?? 'GENERAL_GUARD',
        status: overrides.status ?? 'ACTIVE',
        companyId: company.id,
      },
    });
    await prisma.contract.create({
      data: {
        workerId: worker.id,
        hourlyCostIls: 40,
        minMonthlyHours: overrides.minMonthlyHours ?? 100,
        maxMonthlyHours: overrides.maxMonthlyHours ?? 200,
      },
    });
    // Availability v3: every test in this file schedules shifts inside August 2026, and this
    // worker needs to be fully available (all 3 shifts) on every date of that month by default —
    // matching the "always available" baseline these tests were written against. Under the new
    // "row stores EXCLUDED shifts, absence = available for everything" semantics, that baseline
    // needs NO `WorkerAvailability` rows at all (not a full month of `excludedShifts: 'ABC'` rows,
    // which would now mean the opposite: fully UNavailable). The one test that needs a worker who
    // is NOT available on a specific date (the move-to-unavailable-date test below) creates its own
    // explicit excluding `WorkerAvailability` row instead of calling this helper.
    return worker;
  }

  async function makeRosterWithShift(date: string, shiftType: 'A' | 'B' | 'C' = 'A') {
    // Company-scoped rostering: every `Roster` row now requires a `companyId` -- each call gets
    // its own throwaway company unless the caller needs the roster tied to a SPECIFIC worker's
    // company (see the alert-recompute test below, which passes `roster.companyId` when seeding a
    // `StaffingRequirement` so it's actually scoped to the roster it's meant to affect).
    const company = await prisma.company.create({ data: { name: `Roster Co ${Date.now()}-${Math.random()}` } });
    const roster = await prisma.roster.create({ data: { companyId: company.id, month: date.slice(0, 7) } });
    const shift = await prisma.shift.create({
      data: { rosterId: roster.id, date: new Date(`${date}T00:00:00.000Z`), shiftType },
    });
    return { roster, shift };
  }

  describe('POST /api/shifts/:shiftId/workers (add)', () => {
    it('adds a worker to a shift (201) and persists it', async () => {
      const worker = await makeWorker(401);
      const { shift } = await makeRosterWithShift('2026-08-01');

      const response = await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ shiftId: shift.id, workerId: worker.id, role: 'GENERAL_GUARD' });
      expect(response.body.alerts).toBeInstanceOf(Array);

      const persisted = await prisma.shiftWorker.findUnique({
        where: { shiftId_workerId: { shiftId: shift.id, workerId: worker.id } },
      });
      expect(persisted).not.toBeNull();
    });

    it('returns 404 for an unknown shift', async () => {
      const worker = await makeWorker(402);
      const response = await request(app).post('/api/shifts/999999/workers').send({ workerId: worker.id });
      expect(response.status).toBe(404);
    });

    it('returns 422 (hard rule) and does not persist a duplicate assignment', async () => {
      const worker = await makeWorker(403);
      const { shift } = await makeRosterWithShift('2026-08-01');
      await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

      const response = await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

      expect(response.status).toBe(422);
      expect(response.body.violations.some((v: { code: string }) => v.code === 'noDuplicateSlot')).toBe(true);

      const count = await prisma.shiftWorker.count({ where: { shiftId: shift.id, workerId: worker.id } });
      expect(count).toBe(1);
    });

    it('returns 409 confirmRequired (soft rule) without ?confirm=true, then 201 with it, when hours would exceed max', async () => {
      const worker = await makeWorker(404, { maxMonthlyHours: 0 });
      const { shift } = await makeRosterWithShift('2026-08-01');

      const blocked = await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });
      expect(blocked.status).toBe(409);
      expect(blocked.body.confirmRequired).toBe(true);
      expect(blocked.body.warnings.some((w: { code: string }) => w.code === 'exceedsMaxMonthlyHours')).toBe(true);
      await expect(prisma.shiftWorker.count()).resolves.toBe(0);

      const confirmed = await request(app)
        .post(`/api/shifts/${shift.id}/workers?confirm=true`)
        .send({ workerId: worker.id });
      expect(confirmed.status).toBe(201);
      await expect(prisma.shiftWorker.count()).resolves.toBe(1);
    });

    it('a hard rule can never be bypassed by ?confirm=true', async () => {
      const worker = await makeWorker(405);
      const { shift } = await makeRosterWithShift('2026-08-01');
      await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

      const response = await request(app)
        .post(`/api/shifts/${shift.id}/workers?confirm=true`)
        .send({ workerId: worker.id });

      expect(response.status).toBe(422);
    });

    it('recomputes alerts: filling a required slot clears its unfillable_slot alert', async () => {
      const worker = await makeWorker(406, { minMonthlyHours: 0 });
      const { roster, shift } = await makeRosterWithShift('2026-08-01');
      await prisma.staffingRequirement.create({
        data: { companyId: roster.companyId, role: 'GENERAL_GUARD', shift: 'A', requiredCount: 1 },
      });
      await prisma.alert.create({
        data: {
          rosterId: roster.id,
          type: 'UNFILLABLE_SLOT',
          detail: { date: '2026-08-01', shift: 'A', role: 'GENERAL_GUARD' },
        },
      });

      const response = await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

      expect(response.status).toBe(201);
      expect(
        response.body.alerts.some(
          (a: { type: string; detail: { role?: string } }) =>
            a.type === 'UNFILLABLE_SLOT' && a.detail.role === 'GENERAL_GUARD',
        ),
      ).toBe(false);
      await expect(prisma.alert.count({ where: { rosterId: roster.id } })).resolves.toBe(0);
    });
  });

  describe('POST /api/shifts/:shiftId/workers/:workerId/move', () => {
    it('moves a worker atomically: gone from source, present in target', async () => {
      const worker = await makeWorker(501, { minMonthlyHours: 0 });
      const { roster } = await makeRosterWithShift('2026-08-01');
      const sourceShift = await prisma.shift.findFirstOrThrow({ where: { rosterId: roster.id } });
      const targetShift = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-02T00:00:00.000Z'), shiftType: 'B' },
      });
      await prisma.shiftWorker.create({ data: { shiftId: sourceShift.id, workerId: worker.id, role: 'GENERAL_GUARD' } });

      const response = await request(app)
        .post(`/api/shifts/${sourceShift.id}/workers/${worker.id}/move`)
        .send({ targetShiftId: targetShift.id });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ shiftId: targetShift.id, workerId: worker.id });

      const sourceRow = await prisma.shiftWorker.findUnique({
        where: { shiftId_workerId: { shiftId: sourceShift.id, workerId: worker.id } },
      });
      const targetRow = await prisma.shiftWorker.findUnique({
        where: { shiftId_workerId: { shiftId: targetShift.id, workerId: worker.id } },
      });
      expect(sourceRow).toBeNull();
      expect(targetRow).not.toBeNull();
    });

    it('returns 404 when the worker does not hold the source shift', async () => {
      const worker = await makeWorker(502);
      const { roster, shift: sourceShift } = await makeRosterWithShift('2026-08-01');
      const targetShift = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-02T00:00:00.000Z'), shiftType: 'B' },
      });

      const response = await request(app)
        .post(`/api/shifts/${sourceShift.id}/workers/${worker.id}/move`)
        .send({ targetShiftId: targetShift.id });

      expect(response.status).toBe(404);
    });

    it('returns 422 when the move would violate a hard rule (target unavailable)', async () => {
      const company = await prisma.company.create({ data: { name: 'Move Co.' } });
      const worker = await prisma.worker.create({
        data: { nationalId: validNationalId(503), name: 'Worker 503', role: 'GENERAL_GUARD', companyId: company.id },
      });
      await prisma.contract.create({
        data: { workerId: worker.id, hourlyCostIls: 40, minMonthlyHours: 0, maxMonthlyHours: 200 },
      });
      // Availability v3: a `WorkerAvailability` row EXCLUDING shift A for 2026-08-03 (the move's
      // target date/shift) — an explicit exclusion, not row-absence (which would now mean
      // "available"), so the move below must be hard-blocked by `withinAvailability`.
      await prisma.workerAvailability.create({
        data: { workerId: worker.id, date: new Date('2026-08-03T00:00:00.000Z'), excludedShifts: 'A' },
      });
      const roster = await prisma.roster.create({ data: { companyId: company.id, month: '2026-08' } });
      const sourceShift = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-02T00:00:00.000Z'), shiftType: 'A' },
      });
      const targetShift = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-03T00:00:00.000Z'), shiftType: 'A' },
      });
      await prisma.shiftWorker.create({ data: { shiftId: sourceShift.id, workerId: worker.id, role: 'GENERAL_GUARD' } });

      const response = await request(app)
        .post(`/api/shifts/${sourceShift.id}/workers/${worker.id}/move`)
        .send({ targetShiftId: targetShift.id });

      expect(response.status).toBe(422);
      const stillOnSource = await prisma.shiftWorker.findUnique({
        where: { shiftId_workerId: { shiftId: sourceShift.id, workerId: worker.id } },
      });
      expect(stillOnSource).not.toBeNull();
    });
  });

  describe('DELETE /api/shifts/:shiftId/workers/:workerId', () => {
    it('removes a worker with no violation immediately (204)', async () => {
      const worker = await makeWorker(601, { minMonthlyHours: 0 });
      const { shift } = await makeRosterWithShift('2026-08-01');
      await prisma.shiftWorker.create({ data: { shiftId: shift.id, workerId: worker.id, role: 'GENERAL_GUARD' } });

      const response = await request(app).delete(`/api/shifts/${shift.id}/workers/${worker.id}`);

      expect(response.status).toBe(204);
      await expect(prisma.shiftWorker.count()).resolves.toBe(0);
    });

    it('returns 404 when the worker does not hold the shift', async () => {
      const worker = await makeWorker(602);
      const { shift } = await makeRosterWithShift('2026-08-01');
      const response = await request(app).delete(`/api/shifts/${shift.id}/workers/${worker.id}`);
      expect(response.status).toBe(404);
    });

    it('returns 409 confirmRequired when removal drops the worker below contracted min hours, then 204 with confirm', async () => {
      const worker = await makeWorker(603, { minMonthlyHours: 100 });
      const { shift } = await makeRosterWithShift('2026-08-01');
      await prisma.shiftWorker.create({ data: { shiftId: shift.id, workerId: worker.id, role: 'GENERAL_GUARD' } });

      const blocked = await request(app).delete(`/api/shifts/${shift.id}/workers/${worker.id}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.confirmRequired).toBe(true);
      expect(blocked.body.warnings.some((w: { code: string }) => w.code === 'belowMinMonthlyHours')).toBe(true);
      await expect(prisma.shiftWorker.count()).resolves.toBe(1);

      const confirmed = await request(app).delete(`/api/shifts/${shift.id}/workers/${worker.id}?confirm=true`);
      expect(confirmed.status).toBe(204);
      await expect(prisma.shiftWorker.count()).resolves.toBe(0);
    });

    it('allows removing an INACTIVE worker from a shift they already hold (no hard-rule block)', async () => {
      const worker = await makeWorker(604, { minMonthlyHours: 0, status: 'INACTIVE' });
      const { shift } = await makeRosterWithShift('2026-08-01');
      await prisma.shiftWorker.create({ data: { shiftId: shift.id, workerId: worker.id, role: 'GENERAL_GUARD' } });

      const response = await request(app).delete(`/api/shifts/${shift.id}/workers/${worker.id}`);

      expect(response.status).toBe(204);
    });

    it('re-adding an INACTIVE worker is still 422-blocked', async () => {
      const worker = await makeWorker(605, { status: 'INACTIVE' });
      const { shift } = await makeRosterWithShift('2026-08-01');

      const response = await request(app).post(`/api/shifts/${shift.id}/workers`).send({ workerId: worker.id });

      expect(response.status).toBe(422);
      expect(response.body.violations.some((v: { code: string }) => v.code === 'workerIsActive')).toBe(true);
    });
  });
});
