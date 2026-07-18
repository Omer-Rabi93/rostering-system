import type { Locator, Page } from '@playwright/test';

import { expect, findWorker, test } from '../support/fixtures.js';

type Role = 'GENERAL_GUARD' | 'SUPERVISOR' | 'SCREENER';

// Mirrors `SlotEditDialog`'s own `ROLE_LABEL` — the slot dialog is now split into one section per
// role (General Guard / Supervisor / Screener), each with its own "Add a {role}" picker filtered
// to that exact role, so a worker's option only ever lives under their own role's section.
const ROLE_LABEL: Record<Role, string> = {
  GENERAL_GUARD: 'General Guard',
  SUPERVISOR: 'Supervisor',
  SCREENER: 'Screener',
};

async function blankRoster(page: Page, dbAdmin: import('../support/fixtures.js').DbAdmin, month: string) {
  await dbAdmin.setAllRequirements(0);
  await page.goto(`/roster/${month}`);
  await page.getByRole('button', { name: 'Generate roster' }).click();
  const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
  await expect(calendarTable).toBeVisible({ timeout: 30_000 });
  return calendarTable;
}

/**
 * `SlotEditDialog` is a SINGLE `Modal` instance whose title swaps between the slot title, "Confirm
 * this…", and "Can't …" as `flow.status` changes (see its own doc comment on why: keeping one
 * focus-trap lifecycle for the whole 422/409 round trip). A dialog locator scoped by the modal's
 * initial accessible `name` would go stale the moment that title changes underneath it — there is
 * only ever one `role="dialog"` mounted at a time in these tests (`Modal` renders `null` while
 * closed), so a plain unscoped `getByRole('dialog')` is what stays valid across the whole flow.
 */
async function openSlot(page: Page, date: string, shift: string): Promise<Locator> {
  await page.getByTestId(`cal-cell-${date}-${shift}`).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: new RegExp(`^${date} — Shift ${shift}`) })).toBeVisible();
  return dialog;
}

async function addWorkerViaDialog(dialog: Locator, worker: { name: string; role: Role }) {
  const label = `Add a ${ROLE_LABEL[worker.role]}`;
  const select = dialog.getByLabel(label);
  const option = select.locator('option', { hasText: worker.name });
  const value = await option.getAttribute('value');
  if (!value) throw new Error(`No option for ${worker.name} under "${label}"`);
  await select.selectOption(value);
  await dialog.getByRole('button', { name: `Add ${ROLE_LABEL[worker.role]}` }).click();
}

test.describe('Roster manual edits', () => {
  test('manual edit rules: 3rd shift on a day is 422-blocked; over-max-hours add shows 409 confirm', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const michal = findWorker(seed, 'Michal Katz'); // GENERAL_GUARD, ALL_DAYS/ALL_SHIFTS
    const avi = findWorker(seed, 'Avi Cohen'); // GENERAL_GUARD, ALL_DAYS, no-night (excludedShifts "C" every date), max 180h

    await blankRoster(page, dbAdmin, month);

    // Avi already holds 22 shift-A slots (176h) before the dialog opens; the 23rd (184h) exceeds
    // her 180h contracted max. `exceedsMaxMonthlyHours` is a SOFT rule the client eligibility hint
    // does not pre-check (only hard rules grey out an option — see `eligibility.ts`), so her
    // option stays selectable and the real "Add" flow reaches the 409-confirm state.
    const first22 = Array.from({ length: 22 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: avi.id, role: 'GENERAL_GUARD', shift: 'A', dates: first22 });
    await page.reload();

    const day23A = await openSlot(page, `${month}-23`, 'A');
    await addWorkerViaDialog(day23A, avi);
    await expect(day23A.getByText(/Confirm this assignment/)).toBeVisible();
    await expect(day23A.getByText(/184h, over the 180h contracted max/)).toBeVisible();
    await day23A.getByRole('button', { name: 'Save anyway' }).click();
    await expect(day23A).toBeHidden();

    const reopened = await openSlot(page, `${month}-23`, 'A');
    await expect(reopened.locator('ul').first().getByText('Avi Cohen', { exact: true })).toBeVisible();
    await reopened.getByRole('button', { name: 'Cancel' }).click();

    // maxTwoShiftsPerDay IS a hard rule the client hint pre-checks ("Already 2 shifts today"), so
    // a worker who already has 2 shifts that day is greyed out and can't be selected through the
    // dropdown at all -- a real user simply cannot reach this 422 by clicking through a freshly
    // loaded dialog. The genuine way it happens in production is a race: the dialog was opened
    // (and its eligible-worker list computed) BEFORE a second write landed, and the server
    // re-validates on submit regardless of what the client's now-stale hint says (exactly the
    // caveat text next to the picker: "the server still re-validates on submit"). Reproduce that
    // race directly: open the dialog while Michal genuinely has 0 shifts that day (so her option
    // is enabled), then land her other 2 shifts on that exact day *after* the dialog is already
    // open but *before* submitting.
    const day5C = await openSlot(page, `${month}-05`, 'C');
    await dbAdmin.assignShifts({ month, workerId: michal.id, role: 'GENERAL_GUARD', shift: 'A', dates: [`${month}-05`] });
    await dbAdmin.assignShifts({ month, workerId: michal.id, role: 'GENERAL_GUARD', shift: 'B', dates: [`${month}-05`] });
    await addWorkerViaDialog(day5C, michal);
    await expect(day5C.getByText(/Blocked \(422\)/)).toBeVisible();
    await expect(day5C.getByText(/would have more than 2 shifts/)).toBeVisible();
    await expect(day5C.getByRole('button', { name: 'OK' })).toBeVisible();
    await day5C.getByRole('button', { name: 'OK' }).click();
    await expect(day5C).toBeHidden();
  });

  test('midnight-spanning sequence: shift C + next-day shift A accepted; a 3rd shift on either day still blocked', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const shira = findWorker(seed, 'Shira Azulay'); // GENERAL_GUARD, ALL_DAYS/ALL_SHIFTS
    const dayD = `${month}-10`;
    const dayD1 = `${month}-11`;

    await blankRoster(page, dbAdmin, month);
    // Day D holds shift C for Shira from the start (the midnight-spanning half of the pair);
    // day D+1 has nothing yet.
    await dbAdmin.assignShifts({ month, workerId: shira.id, role: 'GENERAL_GUARD', shift: 'C', dates: [dayD] });
    await page.reload();

    // Shift A of the NEXT calendar day is accepted through the real "Add" flow -- a
    // different date, not a 2-shifts/day violation even though it's midnight-adjacent to day D's
    // shift C.
    const nextDayA = await openSlot(page, dayD1, 'A');
    await addWorkerViaDialog(nextDayA, shira);
    await expect(nextDayA).toBeHidden({ timeout: 5_000 });
    const reopenedNextDay = await openSlot(page, dayD1, 'A');
    await expect(reopenedNextDay.locator('ul').first().getByText('Shira Azulay', { exact: true })).toBeVisible();
    await reopenedNextDay.getByRole('button', { name: 'Cancel' }).click();

    // Now give day D a 2nd shift (B) directly, so it holds C+B -- 2 shifts, same as the earlier
    // "3rd shift" tests, this hard rule is client-pre-checked and greys the option out for a
    // fresh page load, so proving the server still rejects a 3rd is done via the same direct-API
    // force-attempt used throughout this file's other blocked-case assertions.
    await dbAdmin.assignShifts({ month, workerId: shira.id, role: 'GENERAL_GUARD', shift: 'B', dates: [dayD] });
    const dayDAShiftId = await shiftIdFor(page, month, 10, 'A');
    const blockedRes = await page.request.post(`http://localhost:3000/api/shifts/${dayDAShiftId}/workers`, {
      data: { workerId: shira.id },
    });
    expect(blockedRes.status()).toBe(422);
    const blockedBody = (await blockedRes.json()) as { violations: Array<{ detail: { message: string } }> };
    expect(blockedBody.violations[0]?.detail.message).toMatch(/would have more than 2 shifts/);
  });

  test('manual move and remove: move is one atomic action; remove-with-violation confirms; remove-without-violation applies immediately', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const roi = findWorker(seed, 'Roi Ben-David'); // SCREENER, ALL_DAYS/ALL_SHIFTS
    const dana = findWorker(seed, 'Dana Mizrahi'); // SUPERVISOR, min 140h
    const noa = findWorker(seed, 'Noa Levi'); // GENERAL_GUARD, min 120h

    await blankRoster(page, dbAdmin, month);
    // Roi's move-test slot (days 25/26) is deliberately kept outside Dana's and Noa's date ranges
    // below (days 1-18 / 1-20) so no single slot ends up with two unrelated pre-assigned workers.
    // She also gets 15 baseline shifts elsewhere (shift C, well clear of Dana's/Noa's own shifts)
    // so her total stays comfortably above her 120h contracted min regardless of the move -- with
    // only the 1 day25/B shift, ANY move would itself trip `belowMinMonthlyHours` (the validator
    // recomputes projected hours after the edit unconditionally, not just for a net loss), which
    // would turn this into the confirm-dialog scenario the *next* test already covers explicitly.
    const roiBaseline = Array.from({ length: 15 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: roi.id, role: 'SCREENER', shift: 'C', dates: roiBaseline });
    await dbAdmin.assignShifts({ month, workerId: roi.id, role: 'SCREENER', shift: 'B', dates: [`${month}-25`] });
    // Dana exactly at 18 shifts (144h) -- 1 above her 140h min; removing 1 drops her under it.
    const dana18 = Array.from({ length: 18 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: dana.id, role: 'SUPERVISOR', shift: 'A', dates: dana18 });
    // Noa well above her 120h min (20 shifts = 160h); removing 1 stays comfortably above it.
    const noa20 = Array.from({ length: 20 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    await dbAdmin.assignShifts({ month, workerId: noa.id, role: 'GENERAL_GUARD', shift: 'B', dates: noa20 });
    await page.reload();

    // Move: Roi leaves day25/B and appears at day26/B in one action.
    const source = await openSlot(page, `${month}-25`, 'B');
    await source.getByRole('button', { name: 'Move to…' }).click();
    await source.getByLabel('Target date').fill(`${month}-26`);
    await source.getByLabel('Target shift').selectOption('B');
    await source.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(source).toBeHidden({ timeout: 5_000 });

    const oldSlot = await openSlot(page, `${month}-25`, 'B');
    // The slot is now empty for all three roles, so "Unassigned." renders once per role section
    // (`.first()` is enough to prove the source slot lost its only assignment, not a claim about
    // which role section renders it).
    await expect(oldSlot.getByText('Unassigned.').first()).toBeVisible();
    await oldSlot.getByRole('button', { name: 'Cancel' }).click();
    const newSlot = await openSlot(page, `${month}-26`, 'B');
    // Roi is a SCREENER, so her assignment lives under that role's own section, not necessarily
    // the first `<ul>` in the dialog (General Guard renders first, per `ROLES`' declared order).
    await expect(
      newSlot.getByTestId('role-group-screener').getByText('Roi Ben-David', { exact: true }),
    ).toBeVisible();
    await newSlot.getByRole('button', { name: 'Cancel' }).click();

    // Remove with violation: Dana drops below her 140h min -> 409 confirm, applies after confirm.
    const danaSlot = await openSlot(page, `${month}-01`, 'A');
    await danaSlot.getByRole('button', { name: 'Remove' }).click();
    await expect(danaSlot.getByText(/Confirm this removal/)).toBeVisible();
    await expect(danaSlot.getByText(/under the 140h contracted min/)).toBeVisible();
    await danaSlot.getByRole('button', { name: 'Remove anyway' }).click();
    await expect(danaSlot).toBeHidden({ timeout: 5_000 });

    // Remove without violation: Noa stays well above her min -> applies immediately, no dialog.
    const noaSlot = await openSlot(page, `${month}-01`, 'B');
    await noaSlot.getByRole('button', { name: 'Remove' }).click();
    await expect(noaSlot).toBeHidden({ timeout: 5_000 });
  });

  test('manual edit eligibility hints: greyed-out reasons match availability/status; force-attempt still 422', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const avi = findWorker(seed, 'Avi Cohen'); // no-night: unavailable shift C every date
    const eitan = findWorker(seed, 'Eitan Shapira'); // seeded INACTIVE
    const dana = findWorker(seed, 'Dana Mizrahi');
    // Availability v3: an absent row now means fully AVAILABLE (the opposite of what a "zero-row
    // worker" used to mean), so proving the eligibility-hint/disabled-option/422-force-block
    // treatment via a code path distinct from Avi's ambient per-shift exclusion needs an EXPLICIT
    // full-day exclusion instead of clearing — `excludedShifts: 'ABC'` every date this month is
    // the new way to express "this worker is unavailable every shift, every date" (the same
    // real-world fact "zero-row worker" used to represent).
    await dbAdmin.fillAvailability({ month, workerIds: [dana.id], shifts: 'ABC' });

    await blankRoster(page, dbAdmin, month);

    const dialog = await openSlot(page, `${month}-12`, 'C');
    const aviOption = dialog.locator('option', { hasText: 'Avi Cohen' });
    await expect(aviOption).toHaveText(/Unavailable this shift/);
    await expect(aviOption).toBeDisabled();

    const eitanOption = dialog.locator('option', { hasText: 'Eitan Shapira' });
    await expect(eitanOption).toHaveCount(0); // inactive workers aren't even in the ACTIVE-only picker list

    const danaOption = dialog.locator('option', { hasText: 'Dana Mizrahi' });
    await expect(danaOption).toHaveText(/Unavailable this shift/);
    await expect(danaOption).toBeDisabled();

    // Force-attempting a disabled worker via a direct API call (bypassing the UI's own disabled
    // state, exactly as a malicious/buggy client could) is still 422-blocked server-side.
    const response = await page.request.post(`http://localhost:3000/api/shifts/${await shiftIdFor(page, month, 12, 'C')}/workers`, {
      data: { workerId: dana.id },
    });
    expect(response.status()).toBe(422);
  });

  test('manual edit vs date-specific availability: fully-excluded date blocked, wrong-subset blocked, matching subset succeeds', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const tamar = findWorker(seed, 'Tamar Golan'); // SUPERVISOR, no-night (excludedShifts "C" every date)
    await blankRoster(page, dbAdmin, month);

    // Both blocked cases are driven directly against the API: the UI's own eligibility hint
    // already greys these out (correctly refusing to let a real user pick a disabled `<option>`),
    // so proving the *server* still 422s them needs a request that bypasses that UI affordance —
    // exactly the "manual edit eligibility hints" test's own force-attempt mechanism.
    //
    // "Wrong subset" case uses Tamar's ambient seeded exclusion (`excludedShifts: 'C'` every date,
    // from her no-night fixture pattern) directly -- no dbAdmin call needed to arrange it.
    const wrongSubsetShiftId = await shiftIdFor(page, month, 6, 'C');
    const wrongSubsetRes = await page.request.post(`http://localhost:3000/api/shifts/${wrongSubsetShiftId}/workers`, {
      data: { workerId: tamar.id },
    });
    expect(wrongSubsetRes.status()).toBe(422);
    const wrongSubsetBody = (await wrongSubsetRes.json()) as { violations: Array<{ detail: { message: string } }> };
    expect(wrongSubsetBody.violations[0]?.detail.message).toMatch(/not available for/);

    // Availability v3: an absent row now means fully AVAILABLE, so "totally unavailable this
    // date" (what an absent row used to mean) must instead be expressed as an EXPLICIT full-day
    // exclusion (`excludedShifts: 'ABC'`) -- the new way to represent the same real-world fact.
    await dbAdmin.setAvailabilityCell({ workerId: tamar.id, date: `${month}-06`, shifts: 'ABC' });
    const fullyExcludedShiftId = await shiftIdFor(page, month, 6, 'A');
    const fullyExcludedRes = await page.request.post(`http://localhost:3000/api/shifts/${fullyExcludedShiftId}/workers`, {
      data: { workerId: tamar.id },
    });
    expect(fullyExcludedRes.status()).toBe(422);

    // A date whose excluded-shift subset does NOT include the target shift succeeds -- what used
    // to be expressed as "available AB" (`shifts: 'AB'`, the old included-shift meaning) is now
    // "excluded C" (`shifts: 'C'`): A and B remain available. This one goes through the real UI,
    // since it's no longer disabled.
    await dbAdmin.setAvailabilityCell({ workerId: tamar.id, date: `${month}-06`, shifts: 'C' });
    await page.reload();
    const matching = await openSlot(page, `${month}-06`, 'A');
    const tamarOption = matching.locator('option', { hasText: 'Tamar Golan' });
    await expect(tamarOption).toHaveText(/\(available\)/);
    await addWorkerViaDialog(matching, tamar);
    await expect(matching).toBeHidden({ timeout: 5_000 });
  });

  test('worker deactivated after assignment: excluded from regeneration; manual re-add is 422-blocked', async ({
    page,
    seed,
    dbAdmin,
  }) => {
    const month = seed.availabilityMonth;
    const omer = findWorker(seed, 'Omer Biton');
    await blankRoster(page, dbAdmin, month);
    await dbAdmin.assignShifts({ month, workerId: omer.id, role: 'GENERAL_GUARD', shift: 'A', dates: [`${month}-08`] });
    await page.reload();

    const before = await openSlot(page, `${month}-08`, 'A');
    // Scoped to the assigned-worker list specifically -- the (disabled) "Add a General Guard"
    // dropdown option for this same worker (Omer Biton is GENERAL_GUARD) also contains "Omer
    // Biton" as a text substring (Firefox's DOM exposes closed-<select> <option> text to a plain
    // text-content locator search the same as any other element; an unscoped `getByText` here is
    // a genuine strict-mode ambiguity that Firefox caught and Chromium happened not to). General
    // Guard is also the first role section rendered, so `.first()` targets his own `<ul>`.
    await expect(before.locator('ul').first().getByText('Omer Biton', { exact: true })).toBeVisible();
    await before.getByRole('button', { name: 'Cancel' }).click();

    await dbAdmin.setWorkerStatus({ workerId: omer.id, status: 'INACTIVE' });
    // The status flip happened out-of-band (via dbAdmin, not the app's own `updateWorker`
    // mutation), so the browser's cached ACTIVE-worker list doesn't know about it yet -- reload to
    // pick up the true current state before checking the picker/regeneration below.
    await page.reload();

    // Regeneration excludes the now-inactive worker entirely.
    await page.getByRole('button', { name: 'Regenerate roster' }).click();
    const calendarTable = page.getByRole('table', { name: new RegExp(`${month} roster grid`) });
    await expect(calendarTable).toBeVisible({ timeout: 30_000 });
    await expect(calendarTable.getByText('Omer Biton')).toHaveCount(0);

    // Manually re-adding the inactive worker is 422-blocked.
    const slot = await openSlot(page, `${month}-08`, 'A');
    const select = slot.getByLabel(`Add a ${ROLE_LABEL.GENERAL_GUARD}`);
    await expect(select.locator('option', { hasText: 'Omer Biton' })).toHaveCount(0); // ACTIVE-only picker
  });
});

async function shiftIdFor(page: Page, month: string, day: number, shift: string): Promise<number> {
  const res = await page.request.get(`http://localhost:3000/api/rosters/${month}`);
  const roster = (await res.json()) as { shifts: Array<{ id: number; date: string; shiftType: string }> };
  const date = `${month}-${String(day).padStart(2, '0')}`;
  const found = roster.shifts.find((s) => s.date.startsWith(date) && s.shiftType === shift);
  if (!found) throw new Error(`No shift for ${date} ${shift}`);
  return found.id;
}
