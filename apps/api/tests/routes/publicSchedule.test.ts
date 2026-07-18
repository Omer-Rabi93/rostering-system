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

describe('share-link + public schedule', () => {
  const prisma = getTestPrismaClient();
  const app = buildTestApp();

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await disconnectTestPrismaClient();
  });

  async function makePublishedRosterWithWorker() {
    const company = await prisma.company.create({ data: { name: 'Alpha Security Ltd.' } });
    const otherCompany = await prisma.company.create({ data: { name: 'Beta Guarding Co.' } });
    const worker = await prisma.worker.create({
      data: {
        nationalId: validNationalId(701),
        name: 'Noa Levi',
        role: 'GENERAL_GUARD',
        companyId: company.id,
      },
    });
    await prisma.contract.create({
      data: {
        workerId: worker.id,
        hourlyCostIls: 45,
        minMonthlyHours: 100,
        maxMonthlyHours: 200,
      },
    });
    const otherWorker = await prisma.worker.create({
      data: {
        nationalId: validNationalId(702),
        name: 'Someone Else',
        role: 'GENERAL_GUARD',
        companyId: otherCompany.id,
      },
    });

    const roster = await prisma.roster.create({
      data: { companyId: company.id, month: '2026-08', status: 'PUBLISHED', publishedAt: new Date() },
    });
    const shift1 = await prisma.shift.create({
      data: { rosterId: roster.id, date: new Date('2026-08-01T00:00:00.000Z'), shiftType: 'A' },
    });
    const shift2 = await prisma.shift.create({
      data: { rosterId: roster.id, date: new Date('2026-08-02T00:00:00.000Z'), shiftType: 'B' },
    });
    await prisma.shiftWorker.create({ data: { shiftId: shift1.id, workerId: worker.id, role: 'GENERAL_GUARD' } });
    // The other worker's assignment must never leak into `worker`'s public schedule.
    await prisma.shiftWorker.create({ data: { shiftId: shift2.id, workerId: otherWorker.id, role: 'GENERAL_GUARD' } });

    return { worker, otherWorker, roster, company };
  }

  describe('GET /api/workers/:id/share-link', () => {
    it('returns the worker share-link URL', async () => {
      const { worker } = await makePublishedRosterWithWorker();

      const response = await request(app).get(`/api/workers/${worker.id}/share-link`);

      expect(response.status).toBe(200);
      expect(response.body.url).toBe(`/schedule/${worker.shareToken}`);
    });

    it('returns 404 for an unknown worker', async () => {
      const response = await request(app).get('/api/workers/999999/share-link');
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/workers/:id/share-link/rotate', () => {
    it('issues a fresh token and the old token 404s immediately afterwards', async () => {
      const { worker } = await makePublishedRosterWithWorker();

      const before = await request(app).get(`/api/schedule/${worker.shareToken}?month=2026-08`);
      expect(before.status).toBe(200);

      const rotateResponse = await request(app).post(`/api/workers/${worker.id}/share-link/rotate`);
      expect(rotateResponse.status).toBe(200);
      // `url` is the SPA's own frontend route (`/schedule/<token>`, what a worker actually opens
      // in a browser) — NOT the API path (`/api/schedule/<token>`) this test hits directly below.
      const newUrl = rotateResponse.body.url as string;
      expect(newUrl).not.toBe(`/schedule/${worker.shareToken}`);
      const newToken = newUrl.split('/schedule/')[1];

      const oldTokenResponse = await request(app).get(`/api/schedule/${worker.shareToken}?month=2026-08`);
      expect(oldTokenResponse.status).toBe(404);

      const newTokenResponse = await request(app).get(`/api/schedule/${newToken}?month=2026-08`);
      expect(newTokenResponse.status).toBe(200);
    });
  });

  describe('GET /api/schedule/:token', () => {
    it('returns only the worker display name and their own published shifts', async () => {
      const { worker } = await makePublishedRosterWithWorker();

      const response = await request(app).get(`/api/schedule/${worker.shareToken}?month=2026-08`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: 'Noa Levi', month: '2026-08' });
      expect(response.body.shifts).toEqual([{ date: '2026-08-01', shiftType: 'A' }]);
    });

    it('never exposes nationalId, hourly rate, contract data, or other workers assignments', async () => {
      const { worker, otherWorker } = await makePublishedRosterWithWorker();

      const response = await request(app).get(`/api/schedule/${worker.shareToken}?month=2026-08`);

      const serialized = JSON.stringify(response.body);
      expect(response.body).not.toHaveProperty('nationalId');
      expect(response.body).not.toHaveProperty('hourlyCostIls');
      expect(response.body).not.toHaveProperty('contract');
      expect(response.body).not.toHaveProperty('companyId');
      expect(response.body).not.toHaveProperty('shareToken');
      expect(serialized).not.toContain(worker.nationalId);
      expect(serialized).not.toContain('Someone Else');
      expect(serialized).not.toContain(`"workerId":${otherWorker.id}`);
      // shift B (the other worker's assignment) must be absent entirely.
      expect(response.body.shifts.some((s: { shiftType: string }) => s.shiftType === 'B')).toBe(false);
      expect(response.body.shifts).toHaveLength(1);
    });

    it('returns 404 for an unknown token', async () => {
      const response = await request(app).get('/api/schedule/00000000-0000-4000-8000-000000000000?month=2026-08');
      expect(response.status).toBe(404);
    });

    it('returns an identically-shaped 404 for a valid token but an unpublished (draft) month', async () => {
      const { worker, company } = await makePublishedRosterWithWorker();
      await prisma.roster.create({ data: { companyId: company.id, month: '2026-09', status: 'DRAFT' } });

      const unknownTokenResponse = await request(app).get(
        '/api/schedule/00000000-0000-4000-8000-000000000000?month=2026-09',
      );
      const draftMonthResponse = await request(app).get(`/api/schedule/${worker.shareToken}?month=2026-09`);

      expect(unknownTokenResponse.status).toBe(404);
      expect(draftMonthResponse.status).toBe(404);
      expect(draftMonthResponse.body).toEqual(unknownTokenResponse.body);
    });

    it('returns 404 for a valid token with no month query param', async () => {
      const { worker } = await makePublishedRosterWithWorker();
      const response = await request(app).get(`/api/schedule/${worker.shareToken}`);
      expect(response.status).toBe(404);
    });

    it('is per-IP rate limited (low ceiling, unauthenticated route)', async () => {
      const { worker } = await makePublishedRosterWithWorker();

      const responses = [];
      for (let i = 0; i < 35; i++) {
        responses.push(await request(app).get(`/api/schedule/${worker.shareToken}?month=2026-08`));
      }

      expect(responses.some((r) => r.status === 429)).toBe(true);
    });
  });
});
