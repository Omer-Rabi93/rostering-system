import { expect, test } from '../support/fixtures.js';

test.describe('Staffing Requirements — matrix save/reload/validation', () => {
  test('edited headcounts persist across a full page reload', async ({ page }) => {
    await page.goto('/requirements');
    await expect(page.getByRole('heading', { name: 'Staffing Requirements' })).toBeVisible();

    const cell = page.getByLabel('General Guard required, Shift A');
    await expect(cell).toHaveValue('3');
    await cell.fill('5');

    const supervisorB = page.getByLabel('Supervisor required, Shift B');
    await supervisorB.fill('2');

    await page.getByRole('button', { name: 'Save requirements' }).click();
    await expect(page.getByText('Requirements saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('General Guard required, Shift A')).toHaveValue('5');
    await expect(page.getByLabel('Supervisor required, Shift B')).toHaveValue('2');
  });

  test('negative headcount rejected inline; save is a full-matrix replace (a zeroed cell stays zero)', async ({ page }) => {
    await page.goto('/requirements');

    const screenerC = page.getByLabel('Screener required, Shift C');
    await screenerC.fill('-1');
    await page.getByRole('button', { name: 'Save requirements' }).click();

    await expect(page.getByText(/Screener \/ Shift C:/)).toBeVisible();
    // The invalid cell itself is flagged.
    await expect(screenerC).toHaveAttribute('aria-invalid', 'true');

    // Fix it, but also zero out a previously-nonzero cell, and confirm the zero survives reload
    // (proving save is a full-matrix replace, not a sparse patch).
    await screenerC.fill('0');
    const guardB = page.getByLabel('General Guard required, Shift B');
    await guardB.fill('0');
    await page.getByRole('button', { name: 'Save requirements' }).click();
    await expect(page.getByText('Requirements saved.')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Screener required, Shift C')).toHaveValue('0');
    await expect(page.getByLabel('General Guard required, Shift B')).toHaveValue('0');
  });
});
