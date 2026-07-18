import { expect, findCompany, test } from '../support/fixtures.js';
import { deriveValidIsraeliId } from '../support/israeliId.js';

test.describe('Resilience — API/job failure surfacing and polling recovery', () => {
  test('API failure surfacing: a 500 on save shows a generic toast, preserves form input, retry succeeds', async ({
    page,
    seed,
  }) => {
    const alpha = findCompany(seed, 'Alpha Security Ltd.');
    const nationalId = deriveValidIsraeliId(9101);

    let failNext = true;
    await page.route('**/api/workers', async (route) => {
      if (route.request().method() === 'POST' && failNext) {
        failNext = false;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) });
        return;
      }
      await route.continue();
    });

    await page.goto('/workers');
    await page.getByRole('button', { name: '+ New worker' }).click();
    const dialog = page.getByRole('dialog', { name: 'New worker' });
    await dialog.getByLabel('National ID').fill(nationalId);
    await dialog.getByLabel('Full name').fill('Resilience Test Worker');
    await dialog.getByLabel('Company').selectOption(String(alpha.id));
    await dialog.getByLabel('Hourly cost, ILS').fill('40');
    await dialog.getByLabel('Min monthly hours').fill('100');
    await dialog.getByLabel('Max monthly hours').fill('150');
    await dialog.getByRole('button', { name: 'Save worker' }).click();

    // A generic error message, no raw stack trace or schema detail, and the form is untouched.
    await expect(dialog.getByText('Could not save this worker. Please try again.')).toBeVisible();
    await expect(dialog.getByText(/boom/)).toHaveCount(0);
    await expect(dialog.getByText(/stack|TypeError|at Object/i)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Full name')).toHaveValue('Resilience Test Worker');
    await expect(dialog.getByLabel('National ID')).toHaveValue(nationalId);

    // Retrying (interception removed after the first failure) succeeds.
    await dialog.getByRole('button', { name: 'Save worker' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Worker created.')).toBeVisible();
    await expect(page.getByRole('row', { name: /Resilience Test Worker/ })).toBeVisible();
  });

  test('job failure state: JobProgress shows the failure, polling stops, grid unchanged, Generate re-enabled', async ({
    page,
    seed,
  }) => {
    const month = seed.availabilityMonth;
    let pollCount = 0;
    await page.route(`**/api/jobs/*`, async (route) => {
      pollCount++;
      const body = { id: 'fake-job', name: 'roster-generation', state: 'failed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), result: null };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();

    await expect(page.getByText('Generation failed').or(page.getByRole('status').filter({ hasText: /failed/i }))).toBeVisible({
      timeout: 10_000,
    });
    // The grid never appears (generation never actually succeeded server-side, and the mocked job
    // state is terminal-failed) -- still the "no roster" empty state, and the Generate action is
    // available again (not stuck disabled behind a spinner forever).
    await expect(page.getByRole('table', { name: new RegExp(`${month} roster grid`) })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate roster' })).toBeEnabled();

    const countAfterSettling = pollCount;
    await page.waitForTimeout(3_000);
    // Polling stopped once the terminal `failed` state was observed -- no further /jobs/:id calls.
    expect(pollCount).toBe(countAfterSettling);
  });

  test('polling network resilience: 1-2 aborted polls mid-generation still reach the terminal state, no console errors', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    await dbAdmin.setAllRequirements(1);

    // "Failed to load resource" is the browser's own network-layer log line for every non-2xx/
    // aborted request, printed automatically regardless of whether application code handled it --
    // exactly what this test intentionally causes for the 2 poll requests it aborts. It's not
    // signal for "did the app crash"; `pageerror` (uncaught exceptions) and genuine
    // `console.error` calls from application code are.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    let aborted = 0;
    await page.route('**/api/jobs/*', async (route) => {
      if (aborted < 2) {
        aborted++;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.goto(`/roster/${month}`);
    await page.getByRole('button', { name: 'Generate roster' }).click();

    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });
    expect(aborted).toBeGreaterThanOrEqual(1);
    expect(consoleErrors).toHaveLength(0);
  });
});
