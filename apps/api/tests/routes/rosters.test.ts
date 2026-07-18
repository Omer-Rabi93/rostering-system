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

describe('/api/rosters', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  async function makeWorker(prefix: number, overrides: { minMonthlyHours?: number; maxMonthlyHours?: number } = {}) {
    const company = await prisma.company.create({ data: { name: `Company ${prefix}` } });
    const worker = await prisma.worker.create({
      data: {
        nationalId: validNationalId(prefix),
        name: `Worker ${prefix}`,
        role: 'GENERAL_GUARD',
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
    return worker;
  }

  describe('GET /api/rosters/:month', () => {
    it('returns 404 for a month that has not been generated', async () => {
      const response = await request(app).get('/api/rosters/2026-08');
      expect(response.status).toBe(404);
    });

    it('returns the roster with shifts, assignments, and alerts', async () => {
      const worker = await makeWorker(201);
      const roster = await prisma.roster.create({ data: { month: '2026-08', status: 'DRAFT' } });
      const shift = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-01T00:00:00.000Z'), shiftType: 'A' },
      });
      await prisma.shiftWorker.create({ data: { shiftId: shift.id, workerId: worker.id, role: 'GENERAL_GUARD' } });
      await prisma.alert.create({
        data: { rosterId: roster.id, type: 'MIN_HOURS_SHORTFALL', detail: { workerId: worker.id, deficitHours: 92 } },
      });

      const response = await request(app).get('/api/rosters/2026-08');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ month: '2026-08', status: 'DRAFT' });
      expect(response.body.shifts).toHaveLength(1);
      expect(response.body.shifts[0]).toMatchObject({ date: '2026-08-01', shiftType: 'A' });
      expect(response.body.shifts[0].assignments).toEqual([
        { workerId: worker.id, name: 'Worker 201', role: 'GENERAL_GUARD' },
      ]);
      expect(response.body.alerts).toHaveLength(1);
      expect(response.body.alerts[0]).toMatchObject({
        type: 'MIN_HOURS_SHORTFALL',
        acknowledged: false,
        acknowledgedAt: null,
      });
    });
  });

  describe('POST /api/rosters/:id/alerts/:alertId/ack', () => {
    it('acknowledges an alert', async () => {
      const roster = await prisma.roster.create({ data: { month: '2026-08' } });
      const alert = await prisma.alert.create({
        data: { rosterId: roster.id, type: 'MIN_HOURS_SHORTFALL', detail: { workerId: 1, deficitHours: 10 } },
      });

      const response = await request(app).post(`/api/rosters/${roster.id}/alerts/${alert.id}/ack`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: alert.id, acknowledged: true });
      expect(response.body.acknowledgedAt).not.toBeNull();
    });

    it('returns 404 for an unknown alert', async () => {
      const roster = await prisma.roster.create({ data: { month: '2026-08' } });
      const response = await request(app).post(`/api/rosters/${roster.id}/alerts/999999/ack`);
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/rosters/:id/publish', () => {
    it('returns 409 with unacknowledgedAlertIds when alerts are pending', async () => {
      const roster = await prisma.roster.create({ data: { month: '2026-08' } });
      const alert = await prisma.alert.create({
        data: { rosterId: roster.id, type: 'MIN_HOURS_SHORTFALL', detail: { workerId: 1, deficitHours: 10 } },
      });

      const response = await request(app).post(`/api/rosters/${roster.id}/publish`);

      expect(response.status).toBe(409);
      expect(response.body.unacknowledgedAlertIds).toEqual([alert.id]);
    });

    it('publishes once every alert is acknowledged', async () => {
      const roster = await prisma.roster.create({ data: { month: '2026-08' } });
      const alert = await prisma.alert.create({
        data: { rosterId: roster.id, type: 'MIN_HOURS_SHORTFALL', detail: { workerId: 1, deficitHours: 10 } },
      });
      await request(app).post(`/api/rosters/${roster.id}/alerts/${alert.id}/ack`);

      const response = await request(app).post(`/api/rosters/${roster.id}/publish`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'published' });

      const updated = await prisma.roster.findUniqueOrThrow({ where: { id: roster.id } });
      expect(updated.status).toBe('PUBLISHED');
      expect(updated.publishedAt).not.toBeNull();
    });

    it('re-runs the gate on a republish after a fresh unacknowledged alert appears', async () => {
      const roster = await prisma.roster.create({
        data: { month: '2026-08', status: 'PUBLISHED', publishedAt: new Date() },
      });
      const alert = await prisma.alert.create({
        data: { rosterId: roster.id, type: 'MIN_HOURS_SHORTFALL', detail: { workerId: 1, deficitHours: 5 } },
      });

      const response = await request(app).post(`/api/rosters/${roster.id}/publish`);

      expect(response.status).toBe(409);
      expect(response.body.unacknowledgedAlertIds).toEqual([alert.id]);
    });

    it('returns 404 for an unknown roster id', async () => {
      const response = await request(app).post('/api/rosters/999999/publish');
      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/rosters/:month/cost-summary', () => {
    it('returns 404 for a month that has not been generated', async () => {
      const response = await request(app).get('/api/rosters/2026-08/cost-summary');
      expect(response.status).toBe(404);
    });

    it('computes totals as count x 8 x hourlyRate, grouped per worker and per company', async () => {
      const workerA = await makeWorker(301);
      const workerB = await makeWorker(302);
      const roster = await prisma.roster.create({ data: { month: '2026-08' } });
      const shift1 = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-01T00:00:00.000Z'), shiftType: 'A' },
      });
      const shift2 = await prisma.shift.create({
        data: { rosterId: roster.id, date: new Date('2026-08-02T00:00:00.000Z'), shiftType: 'A' },
      });
      // workerA works 2 shifts (16h @ 40 ILS/h = 640 ILS), workerB works 1 shift (8h = 320 ILS).
      await prisma.shiftWorker.create({ data: { shiftId: shift1.id, workerId: workerA.id, role: 'GENERAL_GUARD' } });
      await prisma.shiftWorker.create({ data: { shiftId: shift2.id, workerId: workerA.id, role: 'GENERAL_GUARD' } });
      await prisma.shiftWorker.create({ data: { shiftId: shift1.id, workerId: workerB.id, role: 'GENERAL_GUARD' } });

      const response = await request(app).get('/api/rosters/2026-08/cost-summary');

      expect(response.status).toBe(200);
      expect(response.body.totalIls).toBe(960);
      const workerARow = response.body.perWorker.find((w: { workerId: number }) => w.workerId === workerA.id);
      const workerBRow = response.body.perWorker.find((w: { workerId: number }) => w.workerId === workerB.id);
      expect(workerARow).toMatchObject({ shifts: 2, hours: 16, costIls: 640 });
      expect(workerBRow).toMatchObject({ shifts: 1, hours: 8, costIls: 320 });
      expect(response.body.perCompany).toHaveLength(2);
      const totalPerCompany = response.body.perCompany.reduce(
        (sum: number, c: { costIls: number }) => sum + c.costIls,
        0,
      );
      expect(totalPerCompany).toBe(960);
    });
  });
});
