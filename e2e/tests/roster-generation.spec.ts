import type { Page } from '@playwright/test';

import { expect, test } from '../support/fixtures.js';

async function generateAndWait(page: Page, month: string) {
  await page.goto(`/roster/${month}`);
  await page.getByRole('button', { name: 'Generate roster' }).click();
  const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
  await expect(calendarTable).toBeVisible({ timeout: 30_000 });
  return calendarTable;
}

/** Reads every occupied roster cell into a plain, order-independent structure so two generations
 * of the same problem can be compared for byte-for-byte assignment equality (the CP-SAT
 * determinism guarantee — seed 42, 1 search worker, a time budget banded by workforce size (30s
 * for this suite's small fixtures, up to 1800s for the largest companies — see
 * `solver/solve_roster.py#compute_time_budget_seconds`) — proven at the Python/API level in
 * earlier phases; this is the UI-level confirmation). */
async function readRosterAssignments(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const cell of Array.from(document.querySelectorAll('[data-testid^="cal-cell-"]'))) {
      const testId = cell.getAttribute('data-testid') ?? '';
      const names = Array.from(cell.querySelectorAll('.cal-chip')).map((el) => el.textContent ?? '');
      out[testId] = names.sort();
    }
    return out;
  });
}

test.describe('Roster generation', () => {
  test('generation flow: job progress, calendar populated, deterministic re-generation', async ({ page, seed, dbAdmin }) => {
    const month = seed.availabilityMonth;
    await page.goto(`/roster/${month}`);
    await expect(page.getByText(`No roster for`)).toBeVisible();

    await page.getByRole('button', { name: 'Generate roster' }).click();
    // The job-progress UI appears for this generation (checked by its container class, not its
    // exact in-flight text: with the small seeded fixture, generation can complete faster than a
    // text-specific assertion reliably samples the "Generating…" wording before it flips to
    // "Generated…", which is a real race, not a meaningful behavior difference — the grid
    // visibility assertion right below is the actual proof generation completed and populated).
    await expect(page.locator('.job-progress')).toBeVisible();

    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });
    const firstRun = await readRosterAssignments(page);
    expect(Object.values(firstRun).some((names) => names.length > 0)).toBe(true);

    // Reset to an identical starting state (same seed, same availability rows) and regenerate.
    // Deliberately just `resetAndSeed()` with nothing else — `seedDatabase` reproduces byte-
    // identical company/worker/contract/availability rows every time (same fixture data, same
    // insertion order after TRUNCATE ... RESTART IDENTITY), so this is the same problem input as
    // the first run. (An earlier draft of this test also called `dbAdmin.fillAvailability(...)`
    // here "as a safety net" — that actually gave every worker full `ABC` availability, a
    // materially different input from the varied per-worker seed patterns the first run used,
    // which produced a different-but-valid solution and looked like a determinism failure. That
    // was a test-authoring bug, not a solver bug; removed.)
    await dbAdmin.resetAndSeed();
    const secondRun = await generateAndWait(page, month);
    void secondRun;
    const secondAssignments = await readRosterAssignments(page);

    expect(secondAssignments).toEqual(firstRun);
  });

  const MONTH_BOUNDARY_CASES: ReadonlyArray<{ month: string; days: number; label: string }> = [
    { month: '2027-02', days: 28, label: 'non-leap February' },
    { month: '2028-02', days: 29, label: 'leap February (2028)' },
    { month: '2027-08', days: 31, label: '31-day month' },
  ];

  for (const { month, days, label } of MONTH_BOUNDARY_CASES) {
    test(`month boundary (${label}): calendar renders exactly ${days} day columns x 3 shift rows`, async ({
      page,
      dbAdmin,
    }) => {
      await dbAdmin.seedAvailabilityForMonth(month);
      const calendarTable = await generateAndWait(page, month);

      const headerCells = calendarTable.locator('thead th');
      await expect(headerCells).toHaveCount(days + 1); // +1 for the leading shift-label column
      const bodyRows = calendarTable.locator('tbody tr');
      await expect(bodyRows).toHaveCount(3); // Shift A / B / C, always exactly 3

      const lastDate = `${month}-${String(days).padStart(2, '0')}`;
      await expect(page.getByTestId(`cal-cell-${lastDate}-C`)).toBeVisible();
      // No spill-over: there is no cell for day (days+1), i.e. the 1st of next month.
      const overflowDate = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, days + 1));
      const overflowIso = overflowDate.toISOString().slice(0, 10);
      await expect(page.getByTestId(`cal-cell-${overflowIso}-A`)).toHaveCount(0);
    });
  }

  test('concurrent generation attempt: second click while in-flight surfaces 409, keeps existing job progress', async ({
    page,
    seed,
  }) => {
    const month = seed.availabilityMonth;
    await page.goto(`/roster/${month}`);

    const generateButton = page.getByRole('button', { name: 'Generate roster' });
    await generateButton.click();
    // Fire the second attempt immediately, before the first job can complete.
    await generateButton.click();

    await expect(page.getByText(new RegExp(`A roster generation for .* is already running`))).toBeVisible();
    // The first job's own progress banner is still the one being shown (not reset/duplicated).
    await expect(page.getByRole('status').filter({ hasText: /Generating roster|Generated/ })).toBeVisible();

    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });
  });

  test('empty-workforce generation: all workers deactivated -> terminal job, all-alerts empty roster', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    await dbAdmin.deactivateAllWorkers();

    const calendarTable = await generateAndWait(page, month);
    await expect(calendarTable.getByText('Unassigned').first()).toBeVisible();
    await expect(calendarTable.locator('.cal-chip')).toHaveCount(0);

    await expect(page.getByText(/Alerts \(\d+\)/)).toBeVisible();
    const alertsHeading = await page.getByText(/Alerts \(\d+\)/).textContent();
    expect(alertsHeading).not.toMatch(/Alerts \(0\)/);
    await expect(page.getByText(/unacknowledged — Publish disabled/)).toBeVisible();
  });

  test('all-workers-zero-availability month: active workers, all excluded every shift -> terminal job, all-alerts empty roster', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    // Availability v3: an absent row now means fully AVAILABLE, so "zero availability" (this
    // test's real scenario) can no longer be produced by clearing every row -- that would now make
    // every worker MORE available, not less, and this test would wrongly see a fully-populated
    // roster instead of the all-alerts empty one it asserts. Explicitly exclude every shift, every
    // date, for every active worker instead (the new way to express the same real-world fact).
    await dbAdmin.fillAvailability({ month, shifts: 'ABC' });

    const calendarTable = await generateAndWait(page, month);
    await expect(calendarTable.getByText('Unassigned').first()).toBeVisible();
    await expect(calendarTable.locator('.cal-chip')).toHaveCount(0);
    await expect(page.getByText(/unacknowledged — Publish disabled/)).toBeVisible();
  });
});
