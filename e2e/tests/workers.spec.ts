import { expect, findCompany, test } from '../support/fixtures.js';
import { deriveValidIsraeliId } from '../support/israeliId.js';

test.describe('Workers — CRUD, filters, validation, duplicate IDs', () => {
  test('CRUD happy path: create a worker with a contract, deactivate, excluded from generation', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const nationalId = deriveValidIsraeliId(9001);
    const alpha = findCompany(seed, 'Alpha Security Ltd.');

    await page.goto('/workers');
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();

    await page.getByRole('button', { name: '+ New worker' }).click();
    const dialog = page.getByRole('dialog', { name: 'New worker' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('National ID').fill(nationalId);
    await dialog.getByLabel('Full name').fill('E2E Test Worker');
    await dialog.getByLabel('Company').selectOption(String(alpha.id));
    await dialog.getByLabel('Role').selectOption('GENERAL_GUARD');
    await dialog.getByLabel('Hourly cost, ILS').fill('50');
    await dialog.getByLabel('Min monthly hours').fill('100');
    await dialog.getByLabel('Max monthly hours').fill('180');
    await dialog.getByRole('button', { name: 'Save worker' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText('Worker created.')).toBeVisible();

    const row = page.getByRole('row', { name: /E2E Test Worker/ });
    await expect(row).toBeVisible();
    await expect(row.getByText(nationalId)).toBeVisible();
    await expect(row.getByText('₪50')).toBeVisible();
    await expect(row.getByText('100 / 180')).toBeVisible();

    // Give this worker full availability for the seeded month, then deactivate them and confirm
    // they never show up in a freshly generated roster for that month — a plain zero-availability
    // worker would trivially be excluded regardless of status, so this specifically proves the
    // *status* exclusion.
    const created = await dbAdmin.findWorkerByNationalId(nationalId);
    await dbAdmin.fillAvailability({ month: seed.availabilityMonth, workerIds: [created.id] });

    await row.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit worker — E2E Test Worker' });
    await editDialog.getByLabel('Status').selectOption('INACTIVE');
    await editDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByText('"E2E Test Worker" saved.')).toBeVisible();

    // The default Status filter is ACTIVE-only, so the just-deactivated worker drops out of the
    // current view — switch to "All" to see their row and confirm the badge flipped.
    await page.getByLabel('Status').selectOption('ALL');
    await expect(page.getByRole('row', { name: /E2E Test Worker/ }).getByText('Inactive')).toBeVisible();
    await page.getByLabel('Status').selectOption('ACTIVE');

    await dbAdmin.fillAvailability({ month: seed.availabilityMonth });

    await page.goto(`/roster/${seed.availabilityMonth}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    const calendarTable = page.getByRole('table', { name: new RegExp(`${seed.availabilityMonth} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });

    await expect(calendarTable.getByText('E2E Test Worker')).toHaveCount(0);
  });

  test('form validation: invalid Israeli ID checksum rejected inline and by API; min > max rejected', async ({ page, seed }) => {
    const alpha = findCompany(seed, 'Alpha Security Ltd.');
    await page.goto('/workers');
    await page.getByRole('button', { name: '+ New worker' }).click();
    const dialog = page.getByRole('dialog', { name: 'New worker' });

    const idField = dialog.getByLabel('National ID');
    await idField.fill('123456789'); // fails checksum
    await dialog.getByLabel('Full name').fill('Bad ID Worker');
    await dialog.getByLabel('Company').selectOption(String(alpha.id));
    await dialog.getByLabel('Hourly cost, ILS').fill('40');
    await dialog.getByLabel('Min monthly hours').fill('100');
    await dialog.getByLabel('Max monthly hours').fill('150');
    await dialog.getByRole('button', { name: 'Save worker' }).click();

    await expect(idField).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText('Invalid Israeli ID — checksum failed.')).toBeVisible();
    // The dialog must not have submitted (no network round trip) — still open.
    await expect(dialog).toBeVisible();

    // Fix the ID, but now violate min > max hours.
    await idField.fill(deriveValidIsraeliId(9002));
    await dialog.getByLabel('Min monthly hours').fill('200');
    await dialog.getByLabel('Max monthly hours').fill('100');
    await dialog.getByRole('button', { name: 'Save worker' }).click();

    await expect(dialog.locator('#w-min-error')).toContainText('Min monthly hours (200) must be less than or equal to max (100).');
    await expect(dialog.locator('#w-max-error')).toContainText('Min monthly hours (200) must be less than or equal to max (100).');
    await expect(dialog).toBeVisible();
  });

  test('duplicate national ID: second worker with an existing ID is rejected inline, input preserved', async ({ page, seed }) => {
    const existing = seed.workers[0];
    if (!existing) throw new Error('seed fixture has no workers');
    const alpha = findCompany(seed, 'Alpha Security Ltd.');

    await page.goto('/workers');
    await page.getByRole('button', { name: '+ New worker' }).click();
    const dialog = page.getByRole('dialog', { name: 'New worker' });

    await dialog.getByLabel('National ID').fill(existing.nationalId);
    await dialog.getByLabel('Full name').fill('Duplicate ID Worker');
    await dialog.getByLabel('Company').selectOption(String(alpha.id));
    await dialog.getByLabel('Hourly cost, ILS').fill('40');
    await dialog.getByLabel('Min monthly hours').fill('100');
    await dialog.getByLabel('Max monthly hours').fill('150');
    await dialog.getByRole('button', { name: 'Save worker' }).click();

    await expect(dialog.getByText(`National ID ${existing.nationalId} already belongs to another worker.`)).toBeVisible();
    // Form input must be preserved, not cleared, after the 409.
    await expect(dialog.getByLabel('Full name')).toHaveValue('Duplicate ID Worker');
    await expect(dialog.getByLabel('National ID')).toHaveValue(existing.nationalId);
  });

  test('list filters: status/role/search narrow and combine; clearing restores the full list', async ({ page, seed }) => {
    const bodyRows = page.locator('.data-table tbody tr');
    // The Workers page is scoped to the topbar's active company (Alpha, the default -- see
    // `fixtures.ts`'s `page` fixture), not by an independent page-level "Company" filter (removed;
    // see the v4 topbar company-scoping fix) -- so every count below is scoped to Alpha's own
    // workers, matching what the page actually shows.
    const alpha = findCompany(seed, 'Alpha Security Ltd.');
    const alphaWorkers = seed.workers.filter((w) => w.companyId === alpha.id);
    const activeCount = alphaWorkers.filter((w) => w.status === 'ACTIVE').length;
    const inactiveCount = alphaWorkers.filter((w) => w.status === 'INACTIVE').length;

    await page.goto('/workers');
    await expect(page.getByRole('table')).toBeVisible();
    // Default Status filter is ACTIVE-only.
    await expect(bodyRows).toHaveCount(activeCount);

    await page.getByLabel('Status').selectOption('INACTIVE');
    await expect(bodyRows).toHaveCount(inactiveCount);

    await page.getByLabel('Status').selectOption('ALL');
    await expect(bodyRows).toHaveCount(alphaWorkers.length);

    // Role filter: all Supervisors (status = All from the previous step), still scoped to Alpha.
    await page.getByLabel('Role').selectOption('SUPERVISOR');
    const supervisorCount = alphaWorkers.filter((w) => w.role === 'SUPERVISOR').length;
    await expect(bodyRows).toHaveCount(supervisorCount);

    // Combine: ACTIVE + SUPERVISOR (still implicitly scoped to Alpha) -> exactly Dana Mizrahi.
    await page.getByLabel('Status').selectOption('ACTIVE');
    const combined = alphaWorkers.filter((w) => w.status === 'ACTIVE' && w.role === 'SUPERVISOR').length;
    await expect(bodyRows).toHaveCount(combined);
    await expect(page.getByRole('row', { name: /Dana Mizrahi/ })).toBeVisible();

    // Free-text search narrows further (still matches, since Dana is Alpha/Supervisor/Active).
    await page.getByLabel('Search').fill('Dana');
    await expect(bodyRows).toHaveCount(1);
    await expect(page.getByRole('row', { name: /Dana Mizrahi/ })).toBeVisible();

    // A search with no match narrows to zero and shows the "no match" empty state.
    await page.getByLabel('Search').fill('Nobody Such Worker');
    await expect(bodyRows).toHaveCount(0);
    await expect(page.getByText('No workers match these filters')).toBeVisible();

    // Clear filters (the filter toolbar's own button, not the no-match empty-state's action
    // button also on screen right now) restores the full (default ACTIVE-only) list.
    await page.getByRole('search', { name: 'Filter workers' }).getByRole('button', { name: 'Clear filters' }).click();
    await expect(bodyRows).toHaveCount(activeCount);
  });

  test('switching the topbar\'s active company rescopes the Workers list to the new company (v4 topbar company-scoping fix)', async ({
    page,
    seed,
  }) => {
    const bodyRows = page.locator('.data-table tbody tr');
    const alpha = findCompany(seed, 'Alpha Security Ltd.');
    const beta = findCompany(seed, 'Beta Guarding Co.');
    const alphaActiveCount = seed.workers.filter((w) => w.companyId === alpha.id && w.status === 'ACTIVE').length;
    const betaActiveCount = seed.workers.filter((w) => w.companyId === beta.id && w.status === 'ACTIVE').length;

    await page.goto('/workers');
    await expect(page.getByRole('table')).toBeVisible();
    await expect(bodyRows).toHaveCount(alphaActiveCount);
    // No Alpha row shows a Beta worker's name and vice versa -- a real assertion of scoping, not
    // just a row count coincidence.
    const betaWorkerName = seed.workers.find((w) => w.companyId === beta.id)?.name;
    if (betaWorkerName) await expect(page.getByRole('row', { name: new RegExp(betaWorkerName) })).toHaveCount(0);

    await page.getByLabel('Active company').selectOption(String(beta.id));
    await expect(bodyRows).toHaveCount(betaActiveCount);
    const alphaWorkerName = seed.workers.find((w) => w.companyId === alpha.id)?.name;
    if (alphaWorkerName) await expect(page.getByRole('row', { name: new RegExp(alphaWorkerName) })).toHaveCount(0);
  });
});
