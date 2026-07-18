import type { Page } from '@playwright/test';

import { expect, findWorker, test } from '../support/fixtures.js';

/** Matches `apps/web/src/lib/calendar.ts#currentMonth` (UTC-based) -- `PublicSchedulePage`
 * defaults its month picker to this on load, with no way to pass a month via the URL, so any
 * scenario exercising the "happy path" must publish THIS month, not just the seeded
 * `availabilityMonth` (which is "next calendar month", not "this one"). */
function currentMonthUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function acknowledgeAllAlerts(page: Page): Promise<void> {
  const checkboxes = page.locator('.alert-item input[type="checkbox"]');
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) {
    const checkbox = checkboxes.nth(i);
    if (await checkbox.isChecked()) continue;
    // Retries the click itself, not just the wait: an occasional missed/coalesced click event
    // (observed as a rare flake on WebKit specifically) needs a fresh click, not a longer wait for
    // one that already didn't land.
    let acked = false;
    for (let attempt = 0; attempt < 3 && !acked; attempt++) {
      await checkbox.click();
      try {
        await expect(checkbox).toBeChecked({ timeout: 5_000 });
        acked = true;
      } catch {
        // try again
      }
    }
    if (!acked) await expect(checkbox).toBeChecked();
  }
}

test.describe('Public worker schedule page', () => {
  test('shows the published month for a valid token; unpublished month -> empty state; unknown token -> 404 page; no PII', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = currentMonthUtc();
    const noa = findWorker(seed, 'Noa Levi');
    const dana = findWorker(seed, 'Dana Mizrahi');

    await dbAdmin.setAllRequirements(0);
    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });
    await dbAdmin.assignShifts({ month, workerId: noa.id, role: 'GENERAL_GUARD', shift: 'A', dates: [`${month}-01`, `${month}-02`] });
    await page.reload();
    await expect(page.getByText(/Alerts \(\d+\)/)).toBeVisible();
    await acknowledgeAllAlerts(page);
    await page.getByRole('button', { name: 'Publish roster' }).click();
    await expect(page.getByRole('button', { name: 'Regenerate…' })).toBeVisible();

    // Valid token, default (published) month -> loaded, shows only this worker's own info.
    await page.goto(`/schedule/${noa.shareToken}`);
    await expect(page.getByRole('heading', { name: 'Noa Levi' })).toBeVisible();
    const body = page.locator('body');
    await expect(body).not.toContainText(noa.nationalId);
    await expect(body).not.toContainText(dana.name);
    await expect(body).not.toContainText('₪'); // no rate/cost data on this page at all

    // Switch to a month with no roster at all -> "not published" empty state (we've already
    // proven the token valid this session, so this is unambiguous, per the hook's own design).
    await page.getByLabel('Month').fill('2030-01');
    await expect(page.getByText('No shifts published for January 2030')).toBeVisible();
    await expect(page.getByText(/never shows draft\/unpublished rosters/)).toBeVisible();

    // Unknown token, fresh navigation (no prior success this session) -> the generic invalid-link
    // page, not a stack trace or raw 404.
    await page.goto('/schedule/this-token-does-not-exist');
    await expect(page.getByText("This link isn't valid")).toBeVisible();

    // Rotate Noa's link from the Workers page; the old token stops working, the new one works.
    await page.goto('/workers');
    await page.getByRole('row', { name: /Noa Levi/ }).getByRole('button', { name: 'Share link' }).click();
    const shareModal = page.getByRole('dialog', { name: /public schedule link/ });
    const urlField = shareModal.getByLabel('Read-only URL (no login required)');
    await expect(urlField).toHaveValue(new RegExp(`/schedule/${noa.shareToken}$`));

    await shareModal.getByRole('button', { name: 'Rotate link (invalidates old URL)' }).click();
    await expect(urlField).not.toHaveValue(new RegExp(`/schedule/${noa.shareToken}$`));
    const newUrl = await urlField.inputValue();
    const newToken = newUrl.split('/schedule/')[1];
    if (!newToken) throw new Error('rotated URL had no token segment');

    await page.goto(`/schedule/${noa.shareToken}`); // old token
    await expect(page.getByText("This link isn't valid")).toBeVisible();

    await page.goto(`/schedule/${newToken}`); // new token
    await expect(page.getByRole('heading', { name: 'Noa Levi' })).toBeVisible();
  });

  test('print stylesheet: app chrome hidden, the worker\'s monthly schedule stays fully visible', async ({ page, seed, dbAdmin }) => {
    const month = currentMonthUtc();
    const noa = findWorker(seed, 'Noa Levi');

    await dbAdmin.setAllRequirements(0);
    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();
    await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });
    await dbAdmin.assignShifts({ month, workerId: noa.id, role: 'GENERAL_GUARD', shift: 'A', dates: [`${month}-03`] });
    await page.reload();
    await expect(page.getByText(/Alerts \(\d+\)/)).toBeVisible();
    await acknowledgeAllAlerts(page);
    await page.getByRole('button', { name: 'Publish roster' }).click();
    await expect(page.getByRole('button', { name: 'Regenerate…' })).toBeVisible();

    await page.goto(`/schedule/${noa.shareToken}`);
    await expect(page.getByText('ICTS Rostering — read-only worker schedule (no login)')).toBeVisible();

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.no-print').first()).not.toBeVisible();
    // The worker's name/month heading (rendered specifically for print) and their shift list
    // remain visible/readable under print media.
    await expect(page.locator('.print-only').getByText('Noa Levi')).toBeVisible();
    await expect(page.locator('.badge--shift-a').first()).toBeVisible();
    await expect(page.getByText('Off').first()).toBeVisible();
  });
});
