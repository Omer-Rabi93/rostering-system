import type { Page } from '@playwright/test';

import { expect, test } from '../support/fixtures.js';

async function generateAndWait(page: Page, month: string) {
  await page.goto(`/roster/${month}`);
  await page.getByRole('button', { name: /Generate roster|Regenerate/ }).click();
  const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
  await expect(calendarTable).toBeVisible({ timeout: 30_000 });
  return calendarTable;
}

/** Checks every alert checkbox in the side panel one at a time, via the real acknowledge flow
 * (each check fires the `ackAlert` mutation) — the default 12-worker fixture against the default
 * staffing-requirement matrix genuinely can't fully cover a whole month (contract hour caps are
 * calibrated to the design doc's matrix, not artificially inflated for this test), so a realistic
 * generation naturally raises a non-trivial number of alerts; acknowledging "a lot of them" is a
 * deliberate, real exercise of the gate at scale rather than a contrived minimal count. */
async function acknowledgeAllAlerts(page: Page): Promise<number> {
  const checkboxes = page.locator('.alert-item input[type="checkbox"]');
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) {
    const checkbox = checkboxes.nth(i);
    if (await checkbox.isChecked()) continue;
    // Not `.check()`: it verifies the checked state flipped synchronously after its own click,
    // but acknowledging here is asynchronous (a real `ackAlert` mutation round trip updates the
    // checkbox's `checked` prop only once the server confirms) — `.click()` + a polling
    // `expect(...).toBeChecked()` tolerates that round trip the way `.check()`'s own internal
    // verification does not. Retries the click itself (not just the wait) up to 3 times: an
    // occasional missed/coalesced click event (observed as a rare flake on WebKit specifically)
    // needs a fresh click, not a longer wait for one that already didn't land.
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
  return count;
}

test.describe('Roster alerts + publish gate', () => {
  test.setTimeout(180_000);

  test('alert gate: publish blocked until every alert acknowledged, then succeeds', async ({ page, seed }) => {
    const month = seed.availabilityMonth;
    await generateAndWait(page, month);

    await expect(page.getByText(/Alerts \(\d+\)/)).toBeVisible();
    const alertsLabel = await page.getByText(/Alerts \(\d+\)/).textContent();
    const totalAlerts = Number(alertsLabel?.match(/\((\d+)\)/)?.[1] ?? '0');
    expect(totalAlerts).toBeGreaterThan(0);

    const publishButton = page.getByRole('button', { name: 'Publish roster' });
    await expect(publishButton).toBeDisabled();
    await expect(page.getByText(/unacknowledged — Publish disabled/)).toBeVisible();

    const acked = await acknowledgeAllAlerts(page);
    expect(acked).toBe(totalAlerts);

    await expect(page.getByText('✓ All clear — ready to publish')).toBeVisible();
    await expect(publishButton).toBeEnabled();

    await publishButton.click();
    await expect(page.locator('.toast').getByText(/published\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Regenerate…' })).toBeVisible();
    await expect(publishButton).toBeDisabled();
  });

  test('regenerate a published month: unforced click explains + reopens as draft on confirm, gate resets', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    // A bounded, small-but-nonzero alert count (this test acks twice, once per generation) —
    // the previous test already proves the gate at full realistic (174-alert) scale; this one is
    // about the regenerate/reset mechanics, not alert volume.
    await dbAdmin.setSingleRequirement({ role: 'SUPERVISOR', shift: 'A', requiredCount: 1 });
    await generateAndWait(page, month);
    await acknowledgeAllAlerts(page);
    await page.getByRole('button', { name: 'Publish roster' }).click();
    await expect(page.getByRole('button', { name: 'Regenerate…' })).toBeVisible();

    // Clicking Regenerate on a published month surfaces the explanation before anything happens
    // server-side — no draft is silently touched.
    await page.getByRole('button', { name: 'Regenerate…' }).click();
    const confirmDialog = page.getByRole('dialog', { name: new RegExp(`Regenerate .* ${month.slice(5)}|Regenerate`) });
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText(/currently Published/)).toBeVisible();
    await expect(confirmDialog.getByText(/reopens it as a Draft/)).toBeVisible();

    // Cancel first -> nothing changes, still published.
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Regenerate…' })).toBeVisible();

    // Confirm with force -> reopens as draft, re-raises alerts, gate must be passed again.
    await page.getByRole('button', { name: 'Regenerate…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Regenerate as draft' }).click();

    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Regenerate roster' })).toBeVisible();

    const publishButton = page.getByRole('button', { name: 'Publish roster' });
    await expect(publishButton).toBeDisabled();
    await expect(page.getByText(/unacknowledged — Publish disabled/)).toBeVisible();

    // The gate must be passed again before republishing.
    await acknowledgeAllAlerts(page);
    await expect(publishButton).toBeEnabled();
    await publishButton.click();
    await expect(page.getByRole('button', { name: 'Regenerate…' })).toBeVisible();
  });
});
