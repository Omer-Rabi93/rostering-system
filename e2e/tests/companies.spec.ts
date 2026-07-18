import { expect, test } from '../support/fixtures.js';

test.describe('Companies — CRUD', () => {
  test('create, rename, duplicate name (case-insensitive) rejected, delete rules', async ({ page, seed }) => {
    await page.goto('/companies');
    await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();

    // Create.
    await page.getByRole('button', { name: '+ New company' }).click();
    const createDialog = page.getByRole('dialog', { name: 'New company' });
    await createDialog.getByLabel('Name').fill('Delta Facilities Group');
    await createDialog.getByRole('button', { name: 'Create' }).click();
    await expect(createDialog).toBeHidden();
    await expect(page.getByText('"Delta Facilities Group" created.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Delta Facilities Group/ })).toBeVisible();

    // Rename.
    const deltaRow = page.getByRole('row', { name: /Delta Facilities Group/ });
    await deltaRow.getByRole('button', { name: 'Rename' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Rename company' });
    await editDialog.getByLabel('Name').fill('Delta Facilities Ltd.');
    await editDialog.getByRole('button', { name: 'Save' }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByText('"Delta Facilities Ltd." saved.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Delta Facilities Ltd\./ })).toBeVisible();

    // Duplicate name, case-insensitive, rejected with a 409 surfaced inline.
    await page.getByRole('button', { name: '+ New company' }).click();
    const dupDialog = page.getByRole('dialog', { name: 'New company' });
    await dupDialog.getByLabel('Name').fill('alpha security ltd.');
    await dupDialog.getByRole('button', { name: 'Create' }).click();
    await expect(dupDialog.getByText('A company with this name already exists (names are case-insensitive).')).toBeVisible();
    await expect(dupDialog).toBeVisible();
    await dupDialog.getByRole('button', { name: 'Cancel' }).click();

    // Delete a company WITH workers -> blocked (409), explanatory dialog.
    const alphaRow = page.getByRole('row', { name: /Alpha Security Ltd\./ });
    await expect(alphaRow.getByText(/\d+/)).toBeVisible();
    await alphaRow.getByRole('button', { name: 'Delete' }).click();
    const blockedDialog = page.getByRole('dialog', { name: "Can't delete this company" });
    await expect(blockedDialog).toBeVisible();
    await expect(blockedDialog.getByText(/still has \d+ worker\(s\) assigned/)).toBeVisible();
    await blockedDialog.getByRole('button', { name: 'OK' }).click();
    await expect(blockedDialog).toBeHidden();
    await expect(page.getByRole('row', { name: /Alpha Security Ltd\./ })).toBeVisible();

    // Delete an EMPTY company -> succeeds and disappears from the list.
    const deltaRow2 = page.getByRole('row', { name: /Delta Facilities Ltd\./ });
    await deltaRow2.getByRole('button', { name: 'Delete' }).click();
    const confirmDialog = page.getByRole('dialog', { name: 'Delete "Delta Facilities Ltd."?' });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Delete' }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByText('"Delta Facilities Ltd." deleted.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Delta Facilities Ltd\./ })).toHaveCount(0);

    // Every original seeded company is still present.
    for (const company of seed.companies) {
      await expect(page.getByRole('row', { name: new RegExp(company.name) })).toBeVisible();
    }
  });
});
