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
  });
});
