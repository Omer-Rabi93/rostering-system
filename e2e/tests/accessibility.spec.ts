import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, findWorker, test } from '../support/fixtures.js';
import type { DbAdmin, SeedResult } from '../support/fixtures.js';

const SERIOUS_OR_WORSE = new Set(['serious', 'critical']);

async function assertNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => SERIOUS_OR_WORSE.has(v.impact ?? ''));
  if (bad.length > 0) {
    const details = bad.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`).join('\n');
    throw new Error(`${label}: ${bad.length} serious/critical axe violation(s):\n${details}`);
  }
}

/**
 * Every scenario below is shared between the light-mode (default) and dark-mode `describe`
 * blocks — the flows that get each page into an interesting state (dialogs open, alerts pending,
 * a published roster, etc.) are identical; only the color scheme axe scans against differs. Dark
 * mode is set via Playwright's `colorScheme` context option (`test.use({ colorScheme: 'dark' })`
 * in the dark-mode `describe` below), which drives `prefers-color-scheme` — exactly the media
 * query `packages/ui/src/styles/tokens.css` keys its dark-mode token overrides off of, so this
 * exercises the same CSS path a user's OS-level dark-mode preference would.
 */

async function checkWorkers(page: Page, label: string) {
  await page.goto('/workers');
  await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Workers list`);

  await page.getByRole('button', { name: '+ New worker' }).click();
  await expect(page.getByRole('dialog', { name: 'New worker' })).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Workers — new-worker dialog open`);
}

async function checkCompanies(page: Page, label: string) {
  await page.goto('/companies');
  await expect(page.getByRole('heading', { name: 'Companies' })).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Companies list`);
}

async function checkStaffingRequirements(page: Page, label: string) {
  await page.goto('/requirements');
  await expect(page.getByRole('heading', { name: 'Staffing Requirements' })).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Staffing Requirements`);
}

async function checkRoster(page: Page, seed: SeedResult, dbAdmin: DbAdmin, label: string) {
  const month = seed.availabilityMonth;

  await page.goto(`/roster/${month}`);
  await page.getByRole('tab', { name: 'Availability' }).click();
  await expect(page.getByRole('table', { name: new RegExp(`${month} availability grid`) })).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Roster — availability grid`);

  await page.getByRole('tab', { name: 'Roster grid' }).click();
  await page.getByRole('button', { name: 'Generate roster' }).click();
  const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
  await expect(calendarTable).toBeVisible({ timeout: 30_000 });
  await assertNoSeriousViolations(page, `${label} — Roster — calendar grid + alert checklist`);

  // Open the manual-edit dialog.
  await page.getByTestId(`cal-cell-${month}-01-A`).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Roster — edit dialog open`);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // Open a soft-warning confirm dialog (over-max-hours add).
  const avi = findWorker(seed, 'Avi Cohen');
  const first22 = Array.from({ length: 22 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  await dbAdmin.assignShifts({ month, workerId: avi.id, role: 'GENERAL_GUARD', shift: 'A', dates: first22 });
  await page.reload();
  await page.getByTestId(`cal-cell-${month}-23-A`).click();
  const editDialog = page.getByRole('dialog');
  // Avi Cohen is GENERAL_GUARD, so his option lives under that role's own picker section (the
  // slot dialog is split into one "Add a {role}" section per role — see `SlotEditDialog`).
  const select = editDialog.getByLabel('Add a General Guard');
  const option = editDialog.locator('option', { hasText: 'Avi Cohen' });
  const value = await option.getAttribute('value');
  await select.selectOption(value ?? '');
  await editDialog.getByRole('button', { name: 'Add General Guard' }).click();
  await expect(editDialog.getByText(/Confirm this assignment/)).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Roster — soft-warning confirm dialog open`);
}

async function checkCostDashboard(page: Page, seed: SeedResult, dbAdmin: DbAdmin, label: string) {
  const month = seed.availabilityMonth;
  await dbAdmin.setAllRequirements(0);
  await page.goto(`/roster/${month}`);
  await page.getByRole('button', { name: 'Generate roster' }).click();
  await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });

  await page.goto(`/cost/${month}`);
  await expect(page.getByRole('heading', { name: /Cost Dashboard/ })).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Cost Dashboard`);
}

async function checkPublicSchedule(page: Page, seed: SeedResult, dbAdmin: DbAdmin, label: string) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const noa = findWorker(seed, 'Noa Levi');

  await dbAdmin.setAllRequirements(0);
  await page.goto(`/roster/${month}`);
  await page.getByRole('button', { name: 'Generate roster' }).click();
  await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toBeVisible({ timeout: 30_000 });
  await dbAdmin.assignShifts({ month, workerId: noa.id, role: 'GENERAL_GUARD', shift: 'A', dates: [`${month}-01`] });
  await page.reload();
  await expect(page.getByText(/Alerts \(\d+\)/)).toBeVisible();
  const checkboxes = page.locator('.alert-item input[type="checkbox"]');
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) {
    const cb = checkboxes.nth(i);
    if (await cb.isChecked()) continue;
    // Retries the click itself (not just the wait): an occasional missed/coalesced click event
    // (a rare flake observed on WebKit) needs a fresh click, not a longer wait for one that
    // already didn't land.
    let acked = false;
    for (let attempt = 0; attempt < 3 && !acked; attempt++) {
      await cb.click();
      try {
        await expect(cb).toBeChecked({ timeout: 5_000 });
        acked = true;
      } catch {
        // try again
      }
    }
    if (!acked) await expect(cb).toBeChecked();
  }
  await page.getByRole('button', { name: 'Publish roster' }).click();
  await expect(page.getByRole('button', { name: 'Regenerate…' })).toBeVisible();

  // `/api/schedule/:token` (the data fetch) and `/schedule/:token` (this SPA route) no longer
  // share one literal path, so plain navigation exercises the real thing end to end — no
  // Playwright-level proxy workaround needed (see git history for the pre-fix version of this
  // file, from when the two collided).
  await page.goto(`/schedule/${noa.shareToken}`);
  await expect(page.getByRole('heading', { name: 'Noa Levi' })).toBeVisible();
  await assertNoSeriousViolations(page, `${label} — Public schedule page`);
}

test.describe('Accessibility (axe) — zero serious/critical violations', () => {
  test('Workers — list and open worker form', async ({ page }) => {
    await checkWorkers(page, 'light');
  });

  test('Companies', async ({ page }) => {
    await checkCompanies(page, 'light');
  });

  test('Staffing Requirements', async ({ page }) => {
    await checkStaffingRequirements(page, 'light');
  });

  test('Roster — availability grid, calendar grid, edit dialog, confirm dialog, alert checklist', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    await checkRoster(page, seed, dbAdmin, 'light');
  });

  test('Cost Dashboard', async ({ page, seed, dbAdmin }) => {
    await checkCostDashboard(page, seed, dbAdmin, 'light');
  });

  test('Public schedule page', async ({ page, seed, dbAdmin }) => {
    await checkPublicSchedule(page, seed, dbAdmin, 'light');
  });
});

test.describe('Accessibility (axe) — dark mode — zero serious/critical violations', () => {
  // Drives `prefers-color-scheme: dark`, matching `packages/ui/src/styles/tokens.css`'s dark-mode
  // token overrides (the same signal a user's OS-level dark-mode setting would send) — this app
  // has no in-app theme toggle yet (see tokens.css's doc comment), so OS preference is the only
  // real way dark mode is reached today.
  test.use({ colorScheme: 'dark' });

  test('Workers — list and open worker form', async ({ page }) => {
    await checkWorkers(page, 'dark');
  });

  test('Companies', async ({ page }) => {
    await checkCompanies(page, 'dark');
  });

  test('Staffing Requirements', async ({ page }) => {
    await checkStaffingRequirements(page, 'dark');
  });

  test('Roster — availability grid, calendar grid, edit dialog, confirm dialog, alert checklist', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    await checkRoster(page, seed, dbAdmin, 'dark');
  });

  test('Cost Dashboard', async ({ page, seed, dbAdmin }) => {
    await checkCostDashboard(page, seed, dbAdmin, 'dark');
  });

  test('Public schedule page', async ({ page, seed, dbAdmin }) => {
    await checkPublicSchedule(page, seed, dbAdmin, 'dark');
  });
});
