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

// Folded in from the old standalone `/requirements` page (now removed) -- staffing requirements
// are edited as part of the same company create/edit form, not a separate route/page.
test.describe('Companies — staffing requirements (folded into the company create/edit form)', () => {
  test('setting requirements while creating a company saves them against the new company id', async ({ page }) => {
    await page.goto('/companies');

    await page.getByRole('button', { name: '+ New company' }).click();
    const createDialog = page.getByRole('dialog', { name: 'New company' });
    await createDialog.getByLabel('Name').fill('Echo Guarding Co');
    await createDialog.getByLabel('General Guard required, Shift A').fill('4');
    await createDialog.getByLabel('Supervisor required, Shift B').fill('2');
    await createDialog.getByRole('button', { name: 'Create' }).click();
    await expect(createDialog).toBeHidden();
    await expect(page.getByText('"Echo Guarding Co" created.')).toBeVisible();

    const echoRow = page.getByRole('row', { name: /Echo Guarding Co/ });
    await echoRow.getByRole('button', { name: 'Rename' }).click();
    const editDialog = page.getByRole('dialog', { name: 'Rename company' });
    await expect(editDialog.getByLabel('General Guard required, Shift A')).toHaveValue('4');
    await expect(editDialog.getByLabel('Supervisor required, Shift B')).toHaveValue('2');
    await editDialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('editing a company also edits its staffing-requirements matrix; changes persist across a full page reload', async ({
    page,
    seed,
  }) => {
    const company = seed.companies[0];
    await page.goto('/companies');

    const row = page.getByRole('row', { name: new RegExp(company.name) });
    await row.getByRole('button', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename company' });

    const guardA = dialog.getByLabel('General Guard required, Shift A');
    await expect(guardA).toHaveValue('3');
    await guardA.fill('5');

    const supervisorB = dialog.getByLabel('Supervisor required, Shift B');
    await supervisorB.fill('2');

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`"${company.name}" saved.`)).toBeVisible();

    await page.reload();
    await row.getByRole('button', { name: 'Rename' }).click();
    const reopened = page.getByRole('dialog', { name: 'Rename company' });
    await expect(reopened.getByLabel('General Guard required, Shift A')).toHaveValue('5');
    await expect(reopened.getByLabel('Supervisor required, Shift B')).toHaveValue('2');
    await reopened.getByRole('button', { name: 'Cancel' }).click();
  });

  test('negative headcount is rejected inline in the company edit dialog; save is a full-matrix replace (a zeroed cell stays zero)', async ({
    page,
    seed,
  }) => {
    const company = seed.companies[0];
    await page.goto('/companies');

    const row = page.getByRole('row', { name: new RegExp(company.name) });
    await row.getByRole('button', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename company' });

    const screenerC = dialog.getByLabel('Screener required, Shift C');
    await screenerC.fill('-1');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog.getByText(/Screener \/ Shift C:/)).toBeVisible();
    await expect(screenerC).toHaveAttribute('aria-invalid', 'true');

    // Fix it, but also zero out a previously-nonzero cell, and confirm the zero survives reload
    // (proving save is a full-matrix replace, not a sparse patch).
    await screenerC.fill('0');
    const guardB = dialog.getByLabel('General Guard required, Shift B');
    await guardB.fill('0');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await row.getByRole('button', { name: 'Rename' }).click();
    const reopened = page.getByRole('dialog', { name: 'Rename company' });
    await expect(reopened.getByLabel('Screener required, Shift C')).toHaveValue('0');
    await expect(reopened.getByLabel('General Guard required, Shift B')).toHaveValue('0');
  });
});
