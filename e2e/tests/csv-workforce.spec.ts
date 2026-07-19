import { E2E_API_BASE_URL } from '../../playwright.config.js';
import { expect, findCompany, findWorker, test } from '../support/fixtures.js';

const API = 'http://localhost:3000/api';

/** `companyId` is required by the export route (company-scoped, same as `GET`/`PUT
 * /availability/:month`). Every test below drives its UI through `page.goto('/roster/...')`,
 * whose `page` fixture pre-seeds the active company as `seed.companies[0]` (lowest id -- "Alpha
 * Security Ltd.", matching `dbAdminServer.ts`'s `getDefaultCompanyId()`); passing that same
 * company id here keeps a direct export call scoped to whichever company the UI part of the same
 * test is actually looking at. */
async function fetchWorkforceCsv(
  request: import('@playwright/test').APIRequestContext,
  month: string,
  companyId: number,
): Promise<string> {
  const res = await request.get(`${API}/export/workforce/${month}?companyId=${companyId}`);
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

/** The combined workforce CSV supersedes the two pipelines `csv-workers.spec.ts`/
 * `csv-availability.spec.ts` used to test separately -- see the Part G design doc. One file, one
 * upload, one route (`POST /api/import/workforce/:month` / `GET /api/export/workforce/:month`),
 * living on the Roster page's Availability tab (`WorkforceCsvPanel`), not the Workers page (which
 * no longer has a CSV panel at all). */
test.describe('Workforce CSV import/export', () => {
  test('round-trip: export month M, re-import unmodified -> zero errors', async ({ page, seed, request }) => {
    const month = seed.availabilityMonth;
    const alpha = findCompany(seed, 'Alpha Security Ltd.'); // matches the `page` fixture's default active company
    const original = await fetchWorkforceCsv(request, month, alpha.id);
    const header = original.split('\n')[0]?.trim() ?? '';
    expect(header.startsWith('national_id,name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours,d01')).toBe(true);

    await page.goto(`/roster/${month}`);
    await page.getByRole('tab', { name: 'Availability' }).click();

    const fileInput = page.locator('#workforce-csv-file');
    await fileInput.setInputFiles({ name: `workforce-${month}.csv`, mimeType: 'text/csv', buffer: Buffer.from(original) });
    await page.getByLabel(/I understand this file becomes the authoritative worker list/).check();
    await page.getByRole('button', { name: new RegExp(`^Import workforce-${month}\\.csv$`) }).click();

    const resultDialog = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog).toBeVisible({ timeout: 15_000 });
    const tiles = resultDialog.locator('.stat-tile');
    await expect(tiles.filter({ hasText: 'Failed' }).locator('.stat-tile__value')).toHaveText('0');
    await expect(resultDialog.getByText('Row errors (0)')).toBeVisible();
    await resultDialog.getByRole('button', { name: 'Done' }).click();
  });

  test('per-row errors: bad checksum, unknown role, illegal dNN cell -- reported by row number, batch not aborted, no worker deactivated', async ({
    page,
    seed,
    dbAdmin,
    request,
  }) => {
    const month = seed.availabilityMonth;
    const alpha = findCompany(seed, 'Alpha Security Ltd.'); // matches the `page` fixture's default active company
    const exported = await fetchWorkforceCsv(request, month, alpha.id);
    const header = exported.split('\n')[0] ?? '';
    const dayCount = header.split(',').length - 7;
    const emptyCells = Array.from({ length: dayCount }, () => '').join(',');

    const noa = findWorker(seed, 'Noa Levi');
    const avi = findWorker(seed, 'Avi Cohen');
    const badChecksumRow = `123456789,Bad Checksum Worker,General Guard,Active,40.00,100,150,${emptyCells}`;
    const unknownRoleRow = `${noa.nationalId},${noa.name},Foreman,Active,40.00,100,150,${emptyCells}`;
    const badCellCells = ['AD', ...Array.from({ length: dayCount - 1 }, () => '')].join(',');
    const badCellRow = `${avi.nationalId},${avi.name},General Guard,Active,40.00,100,150,${badCellCells}`;

    const csv = [header, badChecksumRow, unknownRoleRow, badCellRow].join('\n') + '\n';

    await page.goto(`/roster/${month}`);
    await page.getByRole('tab', { name: 'Availability' }).click();
    const fileInput = page.locator('#workforce-csv-file');
    await fileInput.setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByLabel(/I understand this file becomes the authoritative worker list/).check();
    await page.getByRole('button', { name: /^Import bad\.csv$/ }).click();

    const resultDialog = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog).toBeVisible({ timeout: 15_000 });
    const tiles = resultDialog.locator('.stat-tile');
    await expect(tiles.filter({ hasText: 'Failed' }).locator('.stat-tile__value')).toHaveText('3');
    await expect(resultDialog.getByText('Row errors (3)')).toBeVisible();
    await expect(resultDialog.getByRole('cell', { name: '1', exact: true })).toBeVisible();
    await expect(resultDialog.getByRole('cell', { name: '2', exact: true })).toBeVisible();
    await expect(resultDialog.getByRole('cell', { name: '3', exact: true })).toBeVisible();
    await resultDialog.getByRole('button', { name: 'Done' }).click();

    // No worker is ever deactivated by an import -- there is no full-sync deactivation sweep
    // post-merge, only roster-generation-eligibility gating (Worker.lastImportTaskId).
    const workers = await dbAdmin.listWorkers();
    expect(workers.find((w) => w.id === noa.id)?.status).toBe('ACTIVE');
    expect(workers.find((w) => w.id === avi.id)?.status).toBe('ACTIVE');
  });

  test('row atomicity: a bad dNN cell fails the whole row, including the worker upsert (new combined-CSV behavior)', async ({
    page,
    seed,
    dbAdmin,
    request,
  }) => {
    const month = seed.availabilityMonth;
    const alpha = findCompany(seed, 'Alpha Security Ltd.');
    const exported = await fetchWorkforceCsv(request, month, alpha.id);
    const header = exported.split('\n')[0] ?? '';
    const dayCount = header.split(',').length - 7;
    const badCells = ['AD', ...Array.from({ length: dayCount - 1 }, () => '')].join(',');
    const newHireNationalId = '379473606'; // checksum-valid, disjoint from the seed fixture's own ids
    const row = `${newHireNationalId},Never Created,General Guard,Active,40.00,100,150,${badCells}`;
    const csv = [header, row].join('\n') + '\n';

    await page.goto(`/roster/${month}`);
    await page.getByRole('tab', { name: 'Availability' }).click();
    const fileInput = page.locator('#workforce-csv-file');
    await fileInput.setInputFiles({ name: 'atomicity.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByLabel(/I understand this file becomes the authoritative worker list/).check();
    await page.getByRole('button', { name: /^Import atomicity\.csv$/ }).click();

    const resultDialog = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog).toBeVisible({ timeout: 15_000 });
    const tiles = resultDialog.locator('.stat-tile');
    await expect(tiles.filter({ hasText: 'Failed' }).locator('.stat-tile__value')).toHaveText('1');
    await expect(tiles.filter({ hasText: 'Inserted' }).locator('.stat-tile__value')).toHaveText('0');
    await resultDialog.getByRole('button', { name: 'Done' }).click();

    const workers = await dbAdmin.listWorkers();
    expect(workers.find((w) => w.nationalId === newHireNationalId)).toBeUndefined();
  });

  test('wrong month shape: importing a 31-day export into a 30-day target month is rejected with a 400 surfaced in the UI', async ({
    page,
    seed,
    request,
  }) => {
    const thirtyOneDayMonth = '2027-08';
    const thirtyDayMonth = '2027-04';
    const alpha = findCompany(seed, 'Alpha Security Ltd.');
    const wrongShapeCsv = await fetchWorkforceCsv(request, thirtyOneDayMonth, alpha.id);

    await page.goto(`/roster/${thirtyDayMonth}`);
    await page.getByRole('tab', { name: 'Availability' }).click();
    const fileInput = page.locator('#workforce-csv-file');
    await fileInput.setInputFiles({ name: 'wrong-shape.csv', mimeType: 'text/csv', buffer: Buffer.from(wrongShapeCsv) });
    await page.getByLabel(/I understand this file becomes the authoritative worker list/).check();
    await page.getByRole('button', { name: /^Import wrong-shape\.csv$/ }).click();

    // The error must not be swallowed: it's surfaced inline in the panel, and the
    // "importing"/"complete" job-progress dialog never opens.
    await expect(page.getByRole('alert').filter({ hasText: /header/i })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Importing|Import complete/ })).toHaveCount(0);
  });

  test('export link is scoped to the active company and target month', async ({ page, seed }) => {
    const month = seed.availabilityMonth;
    const alpha = findCompany(seed, 'Alpha Security Ltd.');

    await page.goto(`/roster/${month}`);
    await page.getByRole('tab', { name: 'Availability' }).click();

    const exportLink = page.getByRole('link', { name: new RegExp(`Export ${month} workforce`) });
    await expect(exportLink).toHaveAttribute('href', `/api/export/workforce/${month}?companyId=${alpha.id}`);
  });

  test('via the API directly: import completes async, job poll returns the ImportResult, worker fields and availability both land', async ({
    seed,
    request,
  }) => {
    const month = seed.availabilityMonth;
    const alpha = findCompany(seed, 'Alpha Security Ltd.');
    const worker = findWorker(seed, 'Noa Levi');
    const exported = await fetchWorkforceCsv(request, month, alpha.id);
    const header = exported.split('\n')[0] ?? '';
    const dayCount = header.split(',').length - 7;
    const cells = ['A', ...Array.from({ length: dayCount - 1 }, () => '')].join(',');
    const row = `${worker.nationalId},${worker.name},General Guard,Active,55.00,100,180,${cells}`;
    const csv = [header, row].join('\n') + '\n';

    const uploadRes = await request.post(`${API}/import/workforce/${month}`, {
      multipart: {
        companyId: String(alpha.id),
        file: { name: 'api-upload.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
      },
    });
    expect(uploadRes.status()).toBe(202);
    const { jobId } = (await uploadRes.json()) as { jobId: string };

    const job = await pollJob(request, jobId);
    expect(job.state).toBe('completed');
    expect(job.result).toMatchObject({ totalRows: 1, updated: 1, failed: 0 });
  });
});
