import { expect, test } from '../support/fixtures.js';

const API = 'http://localhost:3000/api';

async function fetchWorkersCsv(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get(`${API}/export/workers`);
  expect(res.ok()).toBe(true);
  return res.text();
}

test.describe('Worker CSV import/export', () => {
  test('import sample file, per-row error report shown for a bad row, batch not aborted; export re-imports unmodified (8-column)', async ({
    page,
    seed,
    request,
  }) => {
    const original = await fetchWorkersCsv(request);
    const header = original.split('\n')[0]?.trim() ?? '';
    expect(header).toBe('national_id,name,company_name,role,status,hourly_cost_ils,min_monthly_hours,max_monthly_hours');
    expect(header.split(',')).toHaveLength(8); // no avail_* columns anywhere

    // Round trip 1: re-import the export UNMODIFIED -> zero errors, all rows update cleanly.
    await page.goto('/workers');
    const fileInput = page.locator('#csv-file');
    await fileInput.setInputFiles({ name: 'workers-export.csv', mimeType: 'text/csv', buffer: Buffer.from(original) });
    await page.getByLabel('I understand workers not in this file will be set Inactive.').check();
    await page.getByRole('button', { name: /^Import workers-export\.csv$/ }).click();

    const resultDialog = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog).toBeVisible({ timeout: 15_000 });
    const tiles = resultDialog.locator('.stat-tile');
    await expect(tiles.filter({ hasText: 'Total rows' }).locator('.stat-tile__value')).toHaveText(
      String(seed.workers.length),
    );
    await expect(tiles.filter({ hasText: 'Failed' }).locator('.stat-tile__value')).toHaveText('0');
    await resultDialog.getByRole('button', { name: 'Done' }).click();

    // Round trip 2: append one deliberately bad row (invalid national-ID checksum) -> reported,
    // batch not aborted, the other 12 rows still apply.
    const badRow = '123456789,Bad Checksum Worker,Alpha Security Ltd.,General Guard,Active,40.00,100,150';
    const withBadRow = `${original.trimEnd()}\n${badRow}\n`;
    await fileInput.setInputFiles({ name: 'workers-with-error.csv', mimeType: 'text/csv', buffer: Buffer.from(withBadRow) });
    await page.getByLabel('I understand workers not in this file will be set Inactive.').check();
    await page.getByRole('button', { name: /^Import workers-with-error\.csv$/ }).click();

    const resultDialog2 = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog2).toBeVisible({ timeout: 15_000 });
    await expect(resultDialog2.getByText(`Row errors (1)`)).toBeVisible();
    await expect(resultDialog2.getByRole('cell', { name: '123456789' })).toBeVisible();
    // The 12 valid rows still applied (updated, since they match existing workers).
    const statTiles = resultDialog2.locator('.stat-tile');
    await expect(statTiles.filter({ hasText: 'Updated' }).locator('.stat-tile__value')).toHaveText(
      String(seed.workers.length),
    );
    await resultDialog2.getByRole('button', { name: 'Done' }).click();
  });

  test('full-sync deactivation: a worker missing from the file is set Inactive and listed; an invalid-but-present row stays Active', async ({
    page,
    seed,
    request,
  }) => {
    const original = await fetchWorkersCsv(request);
    const lines = original.split('\n').filter((l) => l.trim() !== '');
    const [header, ...rows] = lines;

    const noaId = seed.workers.find((w) => w.name === 'Noa Levi')?.nationalId;
    const yossi = seed.workers.find((w) => w.name === 'Yossi Peretz');
    if (!noaId || !yossi) throw new Error('fixture missing expected workers');

    const withoutNoa = rows.filter((r) => !r.startsWith(`${noaId},`));
    const mangled = withoutNoa.map((r) =>
      r.startsWith(`${yossi.nationalId},`) ? r.replace(',50.00,', ',-50.00,') : r,
    );
    const modifiedCsv = [header, ...mangled].join('\n') + '\n';

    await page.goto('/workers');
    const fileInput = page.locator('#csv-file');
    await fileInput.setInputFiles({ name: 'workers-sync.csv', mimeType: 'text/csv', buffer: Buffer.from(modifiedCsv) });
    await expect(page.getByText(/Any existing worker whose national ID is not in this file will be set Inactive/)).toBeVisible();
    await page.getByLabel('I understand workers not in this file will be set Inactive.').check();
    await page.getByRole('button', { name: /^Import workers-sync\.csv$/ }).click();

    const resultDialog = page.getByRole('dialog', { name: 'Import complete' });
    await expect(resultDialog).toBeVisible({ timeout: 15_000 });
    await expect(resultDialog.getByText('Deactivated workers (1)')).toBeVisible();
    await expect(resultDialog.getByRole('cell', { name: noaId })).toBeVisible();
    await expect(resultDialog.getByText('Row errors (1)')).toBeVisible();
    await resultDialog.getByRole('button', { name: 'Done' }).click();

    // Noa is now Inactive; Yossi (invalid row, but present) stayed Active, not deactivated.
    await page.getByLabel('Status').selectOption('ALL');
    await expect(page.getByRole('row', { name: /Noa Levi/ }).getByText('Inactive')).toBeVisible();
    await expect(page.getByRole('row', { name: /Yossi Peretz/ }).getByText('Active', { exact: true })).toBeVisible();

    // Flip Noa back to Active via the UI (not by re-importing).
    await page.getByRole('row', { name: /Noa Levi/ }).getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit worker — Noa Levi' });
    await editDialog.getByLabel('Status').selectOption('ACTIVE');
    await editDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByRole('row', { name: /Noa Levi/ }).getByText('Active', { exact: true })).toBeVisible();
  });
});
