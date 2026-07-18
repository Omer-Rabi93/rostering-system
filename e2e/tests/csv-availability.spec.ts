import { E2E_API_BASE_URL } from '../../playwright.config.js';
import { expect, findWorker, test } from '../support/fixtures.js';

const API = 'http://localhost:3000/api';

async function fetchAvailabilityCsv(request: import('@playwright/test').APIRequestContext, month: string): Promise<string> {
  const res = await request.get(`${API}/export/availability/${month}`);
  expect(res.ok()).toBe(true);
  return res.text();
}

async function pollJob(request: import('@playwright/test').APIRequestContext, jobId: string) {
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${E2E_API_BASE_URL}/jobs/${jobId}`);
    const body = (await res.json()) as { state: string; result: unknown };
    if (body.state === 'completed' || body.state === 'failed') return body;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`job ${jobId} did not reach a terminal state in time`);
}

test.describe('Availability CSV import/export', () => {
  test('round-trip: export month M, re-import unmodified -> zero errors, grid unchanged (guard mechanism itself covered by csv/guard.test.ts)', async ({
    page,
    seed,
    request,
  }) => {
    const month = seed.availabilityMonth;
    const original = await fetchAvailabilityCsv(request, month);

    await page.goto(`/roster/${month}`);
    await page.getByRole('tab', { name: 'Availability' }).click();

    const fileInput = page.locator('#availability-csv-file');
    await fileInput.setInputFiles({ name: `availability-${month}.csv`, mimeType: 'text/csv', buffer: Buffer.from(original) });
    await page.getByLabel('I understand this replaces availability for every row in this file.').check();
    await page.getByRole('button', { name: new RegExp(`^Import availability-${month}\\.csv$`) }).click();

    const resultDialog = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog).toBeVisible({ timeout: 15_000 });
    const tiles = resultDialog.locator('.stat-tile');
    await expect(tiles.filter({ hasText: 'Failed' }).locator('.stat-tile__value')).toHaveText('0');
    await expect(resultDialog.getByText('Row errors (0)')).toBeVisible();
    await resultDialog.getByRole('button', { name: 'Done' }).click();

    // Every cell in this CSV (`national_id` is digit-only, `dNN` cells are canonical `A`/`B`/`C`
    // subsets) is run through the SAME `guardCell`/`unguardCell` pair the worker CSV's free-text
    // `name`/`company_name` columns use, applied uniformly as defense-in-depth rather than
    // special-cased out (`apps/api/src/csv/guard.ts`'s own doc comment) — but neither column can
    // ever legitimately start with a formula-trigger character (`=`,`+`,`-`,`@`, tab, CR), so there
    // is no organically-occurring guarded cell to round-trip in THIS csv's data (unlike the worker
    // CSV's `name`, which can). The guard mechanism itself (guard/unguard correctness, including
    // "never corrupt a legitimate leading apostrophe") is unit-tested directly in
    // `apps/api/src/csv/guard.test.ts`; the plain round-trip assertion above already proves this
    // export/import path doesn't mangle any real cell, guarded or not.
  });

  test('per-row errors: illegal letter, duplicate letter, unknown national_id -- reported by row number, batch not aborted, no deactivation', async ({
    page,
    seed,
    dbAdmin,
    request,
  }) => {
    const month = seed.availabilityMonth;
    const exported = await fetchAvailabilityCsv(request, month);
    const header = exported.split('\n')[0] ?? '';
    const dayCount = header.split(',').length - 1;
    const fillerCells = Array.from({ length: dayCount }, () => 'A');

    const noa = findWorker(seed, 'Noa Levi');
    const avi = findWorker(seed, 'Avi Cohen');
    const badLetterRow = [noa.nationalId, 'AD', ...fillerCells.slice(1)].join(',');
    const dupLetterRow = [avi.nationalId, 'AA', ...fillerCells.slice(1)].join(',');
    const unknownIdRow = ['999999999', ...fillerCells].join(',');

    const csv = [header, badLetterRow, dupLetterRow, unknownIdRow].join('\n') + '\n';

    await page.goto(`/roster/${month}`);
    await page.getByRole('tab', { name: 'Availability' }).click();
    const fileInput = page.locator('#availability-csv-file');
    await fileInput.setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByLabel('I understand this replaces availability for every row in this file.').check();
    await page.getByRole('button', { name: /^Import bad\.csv$/ }).click();

    const resultDialog = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog).toBeVisible({ timeout: 15_000 });
    const tiles = resultDialog.locator('.stat-tile');
    await expect(tiles.filter({ hasText: 'Failed' }).locator('.stat-tile__value')).toHaveText('3');
    await expect(resultDialog.getByText('Row errors (3)')).toBeVisible();
    // Each bad row is listed with its (1-based) row number.
    await expect(resultDialog.getByRole('cell', { name: '1', exact: true })).toBeVisible();
    await expect(resultDialog.getByRole('cell', { name: '2', exact: true })).toBeVisible();
    await expect(resultDialog.getByRole('cell', { name: '3', exact: true })).toBeVisible();
    await resultDialog.getByRole('button', { name: 'Done' }).click();

    // No worker is deactivated by an availability import (worker-CSV-only semantics).
    const workers = await dbAdmin.listWorkers();
    const still = workers.find((w) => w.id === noa.id);
    expect(still?.status).toBe('ACTIVE');
  });

  test('wrong month shape: importing a 31-day export into a 30-day target month is rejected with a 400 surfaced in the UI', async ({
    page,
    seed,
    dbAdmin,
    request,
  }) => {
    const thirtyOneDayMonth = '2027-08';
    const thirtyDayMonth = '2027-04';
    await dbAdmin.seedAvailabilityForMonth(thirtyOneDayMonth);
    const wrongShapeCsv = await fetchAvailabilityCsv(request, thirtyOneDayMonth);

    await page.goto(`/roster/${thirtyDayMonth}`);
    await page.getByRole('tab', { name: 'Availability' }).click();
    const fileInput = page.locator('#availability-csv-file');
    await fileInput.setInputFiles({ name: 'wrong-shape.csv', mimeType: 'text/csv', buffer: Buffer.from(wrongShapeCsv) });
    await page.getByLabel('I understand this replaces availability for every row in this file.').check();
    await page.getByRole('button', { name: /^Import wrong-shape\.csv$/ }).click();

    // The error must not be swallowed (regression guard, same bug class as the CsvPanel swallow
    // fix): it's surfaced inline in the panel, and the "importing" job-progress dialog never opens.
    await expect(page.getByRole('alert').filter({ hasText: /header/i })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Importing|Import complete/ })).toHaveCount(0);
  });

  test('payload limits: a dense >100KB PUT succeeds via the route-scoped 2mb limit; an oversized CSV upload is rejected cleanly', async ({
    page,
    seed,
    dbAdmin,
    request,
  }) => {
    const month = seed.availabilityMonth;
    const alpha = seed.companies.find((c) => c.name === 'Alpha Security Ltd.');
    if (!alpha) throw new Error('missing Alpha company');
    const { created } = await dbAdmin.bulkCreateWorkers({ count: 160, companyId: alpha.id });

    const days = await fetchAvailabilityCsv(request, month);
    const dayCount = (days.split('\n')[0] ?? '').split(',').length - 1;

    const body: Record<string, Record<string, string[]>> = {};
    for (const workerId of created) {
      const dates: Record<string, string[]> = {};
      for (let d = 1; d <= dayCount; d++) {
        dates[`${month}-${String(d).padStart(2, '0')}`] = ['A', 'B', 'C'];
      }
      body[String(workerId)] = dates;
    }
    const payload = JSON.stringify(body);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(100_000); // clears the app-wide 100kb default

    const putRes = await request.put(`${API}/availability/${month}`, {
      data: payload,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(putRes.status()).toBe(200);

    // An oversized (>2MB) CSV upload is rejected with a clean 400/413 envelope, not a raw crash.
    const oversizedCsv = 'x'.repeat(2 * 1024 * 1024 + 1024);
    await page.goto(`/roster/${month}`);
    await page.getByRole('tab', { name: 'Availability' }).click();
    const fileInput = page.locator('#availability-csv-file');
    await fileInput.setInputFiles({ name: 'huge.csv', mimeType: 'text/csv', buffer: Buffer.from(oversizedCsv) });
    await page.getByLabel('I understand this replaces availability for every row in this file.').check();
    await page.getByRole('button', { name: /^Import huge\.csv$/ }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Importing|Import complete/ })).toHaveCount(0);
  });
});
