import { expect, findWorker, test } from '../support/fixtures.js';

test.describe('Cost Dashboard', () => {
  test('totals match count x 8 x rate for a small, precisely-controlled fixture', async ({ page, seed, dbAdmin }) => {
    const month = seed.availabilityMonth;
    const noa = findWorker(seed, 'Noa Levi'); // GENERAL_GUARD, Alpha, 45 ILS/h
    const dana = findWorker(seed, 'Dana Mizrahi'); // SUPERVISOR, Alpha, 65 ILS/h

    await dbAdmin.setAllRequirements(0);
    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });

    const noaDates = [1, 2, 3, 4, 5].map((d) => `${month}-${String(d).padStart(2, '0')}`);
    const danaDates = [1, 2, 3].map((d) => `${month}-${String(d).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: noa.id, role: 'GENERAL_GUARD', shift: 'A', dates: noaDates });
    await dbAdmin.assignShifts({ month, workerId: dana.id, role: 'SUPERVISOR', shift: 'B', dates: danaDates });

    // Noa: 5 shifts x 8h x 45 ILS = 1800. Dana: 3 shifts x 8h x 65 ILS = 1560. Total = 3360.
    const expectedNoaCost = 5 * 8 * 45;
    const expectedDanaCost = 3 * 8 * 65;
    const expectedTotal = expectedNoaCost + expectedDanaCost;

    await page.goto(`/cost/${month}`);
    await expect(page.getByRole('heading', { name: new RegExp(`Cost Dashboard`) })).toBeVisible();

    const rosterTotalTile = page.locator('.stat-tile').filter({ hasText: 'Roster total' });
    await expect(rosterTotalTile.locator('.stat-tile__value')).toHaveText(`₪${expectedTotal.toLocaleString('en-US')}`);
    await expect(rosterTotalTile).toContainText('8 shifts');
    await expect(rosterTotalTile).toContainText('64 hours');
    await expect(rosterTotalTile).toContainText('2 workers');

    const workerTable = page.locator('table').filter({ hasText: 'Per-worker cost breakdown' });
    const noaRow = workerTable.getByRole('row', { name: /Noa Levi/ });
    await expect(noaRow).toContainText('5'); // shifts
    await expect(noaRow).toContainText('40'); // hours
    await expect(noaRow).toContainText(`₪${expectedNoaCost.toLocaleString('en-US')}`);

    const danaRow = workerTable.getByRole('row', { name: /Dana Mizrahi/ });
    await expect(danaRow).toContainText('3');
    await expect(danaRow).toContainText('24');
    await expect(danaRow).toContainText(`₪${expectedDanaCost.toLocaleString('en-US')}`);

    const companyTable = page.locator('table').filter({ hasText: 'Cost by company' });
    const alphaRow = companyTable.getByRole('row', { name: /Alpha Security Ltd\./ });
    await expect(alphaRow).toContainText('2'); // workers
    await expect(alphaRow).toContainText('8'); // shifts
    await expect(alphaRow).toContainText('64'); // hours
    await expect(alphaRow).toContainText(`₪${expectedTotal.toLocaleString('en-US')}`);

    // Filtering to Alpha Security Ltd. (the only company with assignments in this fixture) keeps
    // the same total but hides the now-redundant "By company" table; switching back to "All
    // companies" restores it.
    await page.getByLabel('Company').selectOption({ label: 'Alpha Security Ltd.' });
    await expect(page).toHaveURL(new RegExp(`/cost/${month}\\?company=`));
    await expect(rosterTotalTile.locator('.stat-tile__value')).toHaveText(`₪${expectedTotal.toLocaleString('en-US')}`);
    await expect(page.locator('table').filter({ hasText: 'Cost by company' })).toHaveCount(0);
    await expect(workerTable.getByRole('row', { name: /Noa Levi/ })).toBeVisible();

    await page.getByLabel('Company').selectOption({ label: 'All companies' });
    await expect(page).toHaveURL(new RegExp(`/cost/${month}$`));
    await expect(page.locator('table').filter({ hasText: 'Cost by company' })).toHaveCount(1);
  });

  test('clicking a worker\'s name in the By worker table opens their per-worker cost detail page for the month', async ({ page, seed, dbAdmin }) => {
    const month = seed.availabilityMonth;
    const noa = findWorker(seed, 'Noa Levi'); // GENERAL_GUARD, Alpha, 45 ILS/h

    await dbAdmin.setAllRequirements(0);
    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });

    const noaDates = [1, 2, 3].map((d) => `${month}-${String(d).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: noa.id, role: 'GENERAL_GUARD', shift: 'A', dates: noaDates });

    await page.goto(`/cost/${month}`);
    const workerTable = page.locator('table').filter({ hasText: 'Per-worker cost breakdown' });
    await workerTable.getByRole('link', { name: 'Noa Levi' }).click();

    await expect(page).toHaveURL(`/cost/${month}/worker/${noa.id}`);
    await expect(page.getByRole('heading', { name: /Noa Levi/ })).toBeVisible();

    const expectedCost = 3 * 8 * 45;
    const shiftsTile = page.locator('.stat-tile').filter({ hasText: 'Shifts' });
    await expect(shiftsTile.locator('.stat-tile__value')).toHaveText('3');
    const hoursTile = page.locator('.stat-tile').filter({ hasText: 'Hours' });
    await expect(hoursTile.locator('.stat-tile__value')).toHaveText('24');
    const costTile = page.locator('.stat-tile').filter({ hasText: 'Cost' });
    await expect(costTile.locator('.stat-tile__value')).toHaveText(`₪${expectedCost.toLocaleString('en-US')}`);

    const shiftRows = page.getByRole('table').getByRole('row');
    await expect(shiftRows).toHaveCount(4); // header + 3 shifts

    await page.getByRole('link', { name: /back to cost dashboard/i }).click();
    await expect(page).toHaveURL(`/cost/${month}`);
  });

  test('checking 2 workers in the By worker table and clicking Compare shows both workers side by side', async ({ page, seed, dbAdmin }) => {
    const month = seed.availabilityMonth;
    const noa = findWorker(seed, 'Noa Levi'); // GENERAL_GUARD, Alpha, 45 ILS/h
    const dana = findWorker(seed, 'Dana Mizrahi'); // SUPERVISOR, Alpha, 65 ILS/h

    await dbAdmin.setAllRequirements(0);
    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });

    const noaDates = [1, 2, 3, 4, 5].map((d) => `${month}-${String(d).padStart(2, '0')}`);
    const danaDates = [1, 2, 3].map((d) => `${month}-${String(d).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: noa.id, role: 'GENERAL_GUARD', shift: 'A', dates: noaDates });
    await dbAdmin.assignShifts({ month, workerId: dana.id, role: 'SUPERVISOR', shift: 'B', dates: danaDates });

    await page.goto(`/cost/${month}`);

    // No Compare button until 2 workers are checked.
    await expect(page.getByRole('button', { name: /compare/i })).toHaveCount(0);
    await page.getByLabel('Select Noa Levi for comparison').check();
    await expect(page.getByRole('button', { name: /compare/i })).toHaveCount(0);
    await page.getByLabel('Select Dana Mizrahi for comparison').check();

    const compareButton = page.getByRole('button', { name: 'Compare 2 workers' });
    await expect(compareButton).toBeVisible();
    await compareButton.click();

    await expect(page).toHaveURL(new RegExp(`/cost/${month}/compare\\?workers=${noa.id},${dana.id}`));
    await expect(page.getByRole('heading', { name: /Compare Workers/ })).toBeVisible();

    // Noa: 5 shifts x 8h x 45 = 1800. Dana: 3 shifts x 8h x 65 = 1560. Combined summary table is
    // sorted by cost descending, so Noa (the higher earner) leads.
    const expectedNoaCost = 5 * 8 * 45;
    const expectedDanaCost = 3 * 8 * 65;
    const summaryTable = page.locator('table').filter({ hasText: 'Worker comparison summary' });
    const noaSummaryRow = summaryTable.getByRole('row', { name: /Noa Levi/ });
    await expect(noaSummaryRow).toContainText(`₪${expectedNoaCost.toLocaleString('en-US')}`);
    const danaSummaryRow = summaryTable.getByRole('row', { name: /Dana Mizrahi/ });
    await expect(danaSummaryRow).toContainText(`₪${expectedDanaCost.toLocaleString('en-US')}`);

    // Both per-worker cards render with their own matching stat tiles.
    const noaCard = page.locator('.card').filter({ hasText: 'Noa Levi' });
    await expect(noaCard.locator('.stat-tile').filter({ hasText: 'Cost' }).locator('.stat-tile__value')).toHaveText(
      `₪${expectedNoaCost.toLocaleString('en-US')}`,
    );
    const danaCard = page.locator('.card').filter({ hasText: 'Dana Mizrahi' });
    await expect(danaCard.locator('.stat-tile').filter({ hasText: 'Cost' }).locator('.stat-tile__value')).toHaveText(
      `₪${expectedDanaCost.toLocaleString('en-US')}`,
    );

    // Back link returns to the dashboard for the same month.
    await page.getByRole('link', { name: /back to cost dashboard/i }).click();
    await expect(page).toHaveURL(`/cost/${month}`);
  });
});
