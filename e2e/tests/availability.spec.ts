import { E2E_API_BASE_URL } from '../../playwright.config.js';
import { expect, findWorker, test } from '../support/fixtures.js';

async function pollJob(request: import('@playwright/test').APIRequestContext, jobId: string) {
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${E2E_API_BASE_URL}/jobs/${jobId}`);
    const body = (await res.json()) as { state: string; result: unknown };
    if (body.state === 'completed' || body.state === 'failed') return body;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`job ${jobId} did not reach a terminal state in time`);
}

async function openAvailabilityTab(page: import('@playwright/test').Page, month: string) {
  await page.goto(`/roster/${month}`);
  await page.getByRole('tab', { name: 'Availability' }).click();
  await expect(page.getByRole('table', { name: new RegExp(`${month} availability grid`) })).toBeVisible();
}

test.describe('Availability grid', () => {
  test('happy path: A-only on 3 dates, cleared elsewhere, persists, and generation respects it', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const noa = findWorker(seed, 'Noa Levi');
    const otherGuards = seed.workers.filter(
      (w) => w.role === 'GENERAL_GUARD' && w.id !== noa.id && w.status === 'ACTIVE',
    );
    // Make Noa the ONLY available General Guard on her 3 target dates, so the solver's
    // deterministic solution is forced to lean on her there (a positive proof she's used, not
    // just a negative "never violates" check) — she has zero availability everywhere else.
    // Availability v3: an absent row now means fully AVAILABLE (the opposite of pre-v3), so
    // "zero availability everywhere" must be an EXPLICIT full-day exclusion (`excludedShifts:
    // 'ABC'`) rather than clearing every row, which under v3 would make these guards MORE
    // available, not less.
    for (const w of otherGuards) {
      await dbAdmin.fillAvailability({ month, workerIds: [w.id], shifts: 'ABC' });
    }

    const targetDates = [`${month}-03`, `${month}-10`, `${month}-20`];

    await openAvailabilityTab(page, month);

    const noaRow = page.getByRole('row').filter({ hasText: 'Noa Levi' });
    // "All" now marks every shift excluded on every date (fully unavailable) — the new baseline
    // this test needs before carving out the 3 target dates' shift-A availability, replacing the
    // old "None" (clear exclusions) baseline that pre-v3 meant "fully unavailable" but now means
    // the opposite (fully available).
    await noaRow.getByRole('button', { name: 'All' }).click();

    for (const date of targetDates) {
      // Toggling "A" off (it's currently excluded, from the "All" click above) leaves only B and
      // C excluded for this date — i.e. available for shift A only, same real-world outcome the
      // old "toggle A on from a cleared row" flow produced.
      await page.getByTestId(`avail-cell-${noa.id}-${date}`).locator('[data-shift="A"]').click();
    }

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`Availability saved for ${month}.`)).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'Availability' }).click();
    await expect(page.getByRole('table', { name: new RegExp(`${month} availability grid`) })).toBeVisible();
    for (const date of targetDates) {
      await expect(page.getByTestId(`avail-cell-${noa.id}-${date}`)).toHaveAttribute(
        'aria-label',
        `Noa Levi, ${dayLabel(date)}, unavailable for shift B, C`,
      );
    }
    // A date outside the 3 chosen ones stays fully excluded (unavailable) from the "All" click.
    await expect(page.getByTestId(`avail-cell-${noa.id}-${month}-15`)).toHaveAttribute(
      'aria-label',
      `Noa Levi, ${dayLabel(`${month}-15`)}, unavailable`,
    );

    await page.getByRole('tab', { name: 'Roster grid' }).click();
    await page.getByRole('button', { name: 'Generate roster' }).click();
    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });

    for (const date of targetDates) {
      await expect(page.getByTestId(`cal-cell-${date}-A`)).toContainText('Noa Levi');
    }
    // Never assigned outside her 3 available dates/shift.
    await expect(calendarTable.getByText('Noa Levi', { exact: true })).toHaveCount(targetDates.length);
  });

  const MONTH_BOUNDARY_CASES: ReadonlyArray<{ month: string; days: number; label: string }> = [
    { month: '2027-02', days: 28, label: 'non-leap February' },
    { month: '2028-02', days: 29, label: 'leap February (2028)' },
    { month: '2027-04', days: 30, label: '30-day month' },
    { month: '2027-08', days: 31, label: '31-day month' },
  ];

  for (const { month, days, label } of MONTH_BOUNDARY_CASES) {
    test(`month boundary (${label}): grid renders exactly ${days} date columns, CSV round-trips`, async ({
      page,
      dbAdmin,
      request,
    }) => {
      await dbAdmin.seedAvailabilityForMonth(month);
      await openAvailabilityTab(page, month);

      const headerCells = page.locator('.cal-table thead th');
      // +1 for the leading "Worker" column.
      await expect(headerCells).toHaveCount(days + 1);
      // No spill-over into an adjacent month: the last column's cell for the first worker row is
      // this month's last date, not day 1 of the next month.
      const lastDate = `${month}-${String(days).padStart(2, '0')}`;
      await expect(page.locator('.cal-table tbody tr').first().locator('td').last()).toHaveAttribute(
        'data-testid',
        new RegExp(`-${lastDate}$`),
      );

      const exportRes = await request.get(`${E2E_API_BASE_URL}/export/availability/${month}`);
      expect(exportRes.ok()).toBe(true);
      const csvText = await exportRes.text();
      const header = csvText.split('\n')[0]?.trim() ?? '';
      const columns = header.split(',');
      expect(columns).toHaveLength(days + 1);
      expect(columns[0]).toBe('national_id');
      expect(columns[1]).toBe('d01');
      expect(columns[columns.length - 1]).toBe(`d${String(days).padStart(2, '0')}`);

      // Re-importing the unmodified export must apply cleanly with zero row errors.
      const importRes = await request.post(`${E2E_API_BASE_URL}/import/availability/${month}`, {
        multipart: { file: { name: `availability-${month}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csvText) } },
      });
      expect(importRes.status()).toBe(202);
      const { jobId } = (await importRes.json()) as { jobId: string };
      const job = await pollJob(request, jobId);
      expect(job.state).toBe('completed');
      const result = job.result as { failed: number; errors: unknown[] };
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  }

  test('zero-availability worker: all-unavailable grid row, never assigned by generation', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const dana = findWorker(seed, 'Dana Mizrahi'); // a Supervisor, so removing her doesn't starve GG coverage
    // Availability v3: an absent row now means fully AVAILABLE, so "zero availability" (the same
    // real-world fact this test's title/intent still names) must be an EXPLICIT full-day exclusion
    // every date this month, not a cleared/absent row (which would now mean the opposite).
    await dbAdmin.fillAvailability({ month, workerIds: [dana.id], shifts: 'ABC' });

    await openAvailabilityTab(page, month);
    const danaRow = page.getByRole('row').filter({ hasText: 'Dana Mizrahi' });
    await expect(danaRow).toBeVisible();
    const firstCell = danaRow.locator('td[role="gridcell"]').first();
    await expect(firstCell).toHaveAttribute('aria-label', /Dana Mizrahi, .+, unavailable/);
    const cellCount = await danaRow.locator('td[role="gridcell"]').count();
    for (let i = 0; i < cellCount; i++) {
      await expect(danaRow.locator('td[role="gridcell"]').nth(i)).toHaveAttribute(
        'aria-label',
        /Dana Mizrahi, .+, unavailable/,
      );
    }

    await page.getByRole('tab', { name: 'Roster grid' }).click();
    await page.getByRole('button', { name: 'Generate roster' }).click();
    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });
    await expect(calendarTable.getByText('Dana Mizrahi', { exact: true })).toHaveCount(0);
  });

  test('keyboard-only availability grid: Tab enters once, arrows move, letter keys toggle, saved by keyboard', async ({
    page,
    seed,
  }) => {
    const month = seed.availabilityMonth;
    const noa = findWorker(seed, 'Noa Levi');
    await openAvailabilityTab(page, month);

    const firstCell = page.getByTestId(`avail-cell-${noa.id}-${month}-01`);
    await firstCell.focus();
    await expect(firstCell).toBeFocused();

    // Move right once with ArrowRight -> lands on day 2, still one single roving tab stop (no
    // separate stops for the A/B/C sub-toggles).
    await page.keyboard.press('ArrowRight');
    const secondCell = page.getByTestId(`avail-cell-${noa.id}-${month}-02`);
    await expect(secondCell).toBeFocused();
    await expect(firstCell).toHaveAttribute('tabindex', '-1');
    await expect(secondCell).toHaveAttribute('tabindex', '0');

    // Noa is fully available every date by seed default (no exclusion row at all -- Availability
    // v3: an absent row means available for everything); toggling shift B on the focused cell via
    // the letter key marks B EXCLUDED, and the cell's aria-label updates to reflect exactly that
    // new subset.
    const beforeLabel = await secondCell.getAttribute('aria-label');
    expect(beforeLabel).toBe(`Noa Levi, ${dayLabel(`${month}-02`)}, available for all shifts`);
    await page.keyboard.press('b');
    await expect(secondCell).not.toHaveAttribute('aria-label', beforeLabel ?? '');
    const afterLabel = await secondCell.getAttribute('aria-label');
    expect(afterLabel).toBe(`Noa Levi, ${dayLabel(`${month}-02`)}, unavailable for shift B`);

    // Home moves back to the first cell of the row.
    await page.keyboard.press('Home');
    await expect(firstCell).toBeFocused();

    // Save entirely via keyboard (Tab out of the grid to the toolbar buttons, then Enter/Space).
    await page.getByRole('button', { name: 'Save changes' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(`Availability saved for ${month}.`)).toBeVisible();

    await page.reload();
    await page.getByRole('tab', { name: 'Availability' }).click();
    await expect(page.getByTestId(`avail-cell-${noa.id}-${month}-02`)).toHaveAttribute('aria-label', afterLabel ?? '');
  });
});

function dayLabel(date: string): string {
  const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [, monthStr, dayStr] = date.split('-');
  const monthIndex = Number(monthStr) - 1;
  return `${MONTH_NAMES_SHORT[monthIndex]} ${Number(dayStr)}`;
}
