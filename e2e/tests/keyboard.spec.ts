import { expect, findWorker, test } from '../support/fixtures.js';

test.describe('Keyboard-only interaction', () => {
  test('calendar grid: Tab enters, arrows move the roving tabindex, Enter opens the dialog, closing returns focus to the cell', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    await dbAdmin.setAllRequirements(0);
    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });

    // Tab from the top of the page until focus lands inside the grid -- no mouse interaction at
    // any point in this test.
    let landedOnGrid = false;
    let testId: string | null = null;
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      testId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
      if (testId?.startsWith('cal-cell-')) {
        landedOnGrid = true;
        break;
      }
    }
    expect(landedOnGrid).toBe(true);
    const firstCellTestId = testId;
    const firstCell = page.locator(`[data-testid="${firstCellTestId}"]`);
    await expect(firstCell).toBeFocused();
    await expect(firstCell).toHaveAttribute('tabindex', '0');

    // Arrow-Right moves the roving tabindex to the next day's same shift.
    await page.keyboard.press('ArrowRight');
    const secondTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    expect(secondTestId).not.toBe(firstCellTestId);
    await expect(firstCell).toHaveAttribute('tabindex', '-1');
    const secondCell = page.locator(`[data-testid="${secondTestId}"]`);
    await expect(secondCell).toHaveAttribute('tabindex', '0');

    // Enter opens the manual-edit dialog for the focused (second) cell.
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const [, date, shift] = secondTestId?.match(/^cal-cell-(.+)-([ABC])$/) ?? [];
    await expect(dialog.getByRole('heading', { name: new RegExp(`^${date} — Shift ${shift}`) })).toBeVisible();

    // Escape closes it, entirely by keyboard, and focus returns to the originating cell.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(secondCell).toBeFocused();
  });

  test('confirm-dialog flow: a 409 soft-warning confirm is completed entirely by keyboard, with focus trapped and restored', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const avi = findWorker(seed, 'Avi Cohen'); // max 180h contracted

    await dbAdmin.setAllRequirements(0);
    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });
    const first22 = Array.from({ length: 22 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: avi.id, role: 'GENERAL_GUARD', shift: 'A', dates: first22 });
    await page.reload();

    const trigger = page.getByTestId(`cal-cell-${month}-23-A`);
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Initial focus lands inside the dialog (never back on the page body/trigger).
    await expect(page.locator(':focus')).not.toHaveAttribute('data-testid', `cal-cell-${month}-23-A`);

    // Native <select> typeahead-by-typing is notoriously flaky to drive via synthetic key events
    // (browsers reset the search buffer between events that don't land within the same tick as a
    // real keypress would) -- `selectOption` is used here instead: a programmatic, mouse-free API
    // (no click/drag simulated), keeping this step within "no mouse interaction" while the rest of
    // the flow (Tab, Enter, Escape, focus assertions) is real keyboard events throughout.
    // Avi Cohen is GENERAL_GUARD, so her option/picker/button live under that role's own section
    // (the slot dialog is split into one "Add a {role}" section per role — see `SlotEditDialog`).
    const select = dialog.getByLabel('Add a General Guard');
    await select.focus();
    await select.selectOption(String(avi.id));

    // Reach "Add General Guard" and activate it with Enter. WebKit's default Tab order (matching
    // real Safari, absent the OS-level "Full Keyboard Access" preference) does not include plain
    // `<button>` elements at all -- a permanent, documented WebKit/Safari default, not an app or
    // test bug (see Playwright's own WebKit-keyboard-navigation notes) -- so counting literal Tab
    // presses to land on a button is not a portable cross-browser technique. `.focus()` reaches it
    // without simulating a mouse click, keeping this within "no mouse interaction"; Enter still
    // performs the real keyboard activation this scenario is about.
    const addToShiftButton = dialog.getByRole('button', { name: 'Add General Guard' });
    await addToShiftButton.focus();
    await expect(addToShiftButton).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(dialog.getByText(/Confirm this assignment/)).toBeVisible();

    // Tab is trapped within the dialog: from the last focusable element (Save anyway), Tab wraps
    // back to the first (the header's Close (x) button), never escaping to the page behind it.
    const closeButton = dialog.getByRole('button', { name: 'Close' });
    const confirmButton = dialog.getByRole('button', { name: 'Save anyway' });
    await expect(confirmButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();

    // Escape cancels without applying.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    const stillEmpty = await openAndCheckUnassigned(page, month);
    expect(stillEmpty).toBe(true);

    // Redo, this time activating Confirm via keyboard -- applies the edit and restores focus to
    // the trigger.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog2 = page.getByRole('dialog');
    const select2 = dialog2.getByLabel('Add a General Guard');
    await select2.focus();
    await select2.selectOption(String(avi.id));
    // See the identical note above re: WebKit's Tab order skipping plain buttons.
    await dialog2.getByRole('button', { name: 'Add General Guard' }).focus();
    await page.keyboard.press('Enter'); // Add General Guard
    await expect(dialog2.getByText(/Confirm this assignment/)).toBeVisible();
    await expect(dialog2.getByRole('button', { name: 'Save anyway' })).toBeFocused();
    await page.keyboard.press('Enter'); // activates Save anyway
    await expect(dialog2).toBeHidden({ timeout: 5_000 });
    await expect(trigger).toBeFocused();
  });
});

async function openAndCheckUnassigned(page: import('@playwright/test').Page, month: string): Promise<boolean> {
  await page.getByTestId(`cal-cell-${month}-23-A`).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: new RegExp(`^${month}-23 — Shift A`) })).toBeVisible();
  // A fully-empty slot shows "Unassigned." once per role section (General Guard / Supervisor /
  // Screener) — `.first()` is enough to confirm nothing was applied.
  const isUnassigned = await dialog.getByText('Unassigned.').first().isVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  return isUnassigned;
}
