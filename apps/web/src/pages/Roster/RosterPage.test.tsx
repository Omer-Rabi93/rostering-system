import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Roster } from '@rostering/shared';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { renderWithProviders } from '../../testUtils/renderWithProviders.js';
import { RosterPage } from './RosterPage.js';

const ALL_AVAILABLE = Array.from({ length: 7 }, () => [true, true, true]);

function makeWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    nationalId: '123456782',
    name: 'Omer Cohen',
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    companyId: 1,
    shareToken: 'tok-2',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contract: {
      workerId: 2,
      hourlyCostIls: 48,
      minMonthlyHours: 140,
      maxMonthlyHours: 186,
      availability: ALL_AVAILABLE,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeRoster(overrides: Partial<Roster> = {}): Roster {
  return {
    id: 1,
    month: '2026-08',
    status: 'DRAFT',
    generatedAt: '2026-08-01T00:00:00.000Z',
    publishedAt: null,
    shifts: [
      { id: 10, date: '2026-08-01', shiftType: 'A', assignments: [{ workerId: 1, name: 'Dana Levi', role: 'SUPERVISOR' }] },
    ],
    alerts: [],
    ...overrides,
  };
}

const WORKERS_ROUTE = { method: 'GET' as const, match: /^\/api\/workers/, respond: () => ({ status: 200, body: [makeWorker()] }) };

// `SlotEditDialog`'s eligibility hints now come from `GET /api/availability/:month` (Availability
// v2) instead of `contract.availability` — worker id 2 ("Omer Cohen") needs a matching entry on
// whichever date/shift a test opens the "Add a worker" picker for, or the option renders disabled
// and `user.selectOptions` can't select it.
const AVAILABILITY_ROUTE = {
  method: 'GET' as const,
  match: '/api/availability/2026-08',
  respond: () => ({
    status: 200,
    body: { '2': { '2026-08-01': ['A', 'B', 'C'], '2026-08-02': ['A', 'B', 'C'] } },
  }),
};

// `SlotEditDialog`'s role-grouped sections each show "assigned X of Y required", where Y comes
// from this role×shift matrix (`useListStaffingRequirementsQuery`) — the dialog fetches it
// unconditionally once mounted (i.e. as soon as any slot is opened), so every test that opens the
// dialog needs this route mocked or `installMockFetch` throws "No mock route for GET
// /api/staffing-requirements".
const STAFFING_REQUIREMENTS_ROUTE = {
  method: 'GET' as const,
  match: '/api/staffing-requirements',
  respond: () => ({
    status: 200,
    body: [
      { role: 'GENERAL_GUARD', shift: 'A', requiredCount: 2 },
      { role: 'SUPERVISOR', shift: 'A', requiredCount: 1 },
      { role: 'SCREENER', shift: 'A', requiredCount: 1 },
      { role: 'GENERAL_GUARD', shift: 'B', requiredCount: 2 },
      { role: 'SUPERVISOR', shift: 'B', requiredCount: 1 },
      { role: 'SCREENER', shift: 'B', requiredCount: 1 },
      { role: 'GENERAL_GUARD', shift: 'C', requiredCount: 2 },
      { role: 'SUPERVISOR', shift: 'C', requiredCount: 1 },
      { role: 'SCREENER', shift: 'C', requiredCount: 1 },
    ],
  }),
};

describe('RosterPage', () => {
  it('generate -> job polling -> completion refreshes the grid via Roster-tag cache invalidation, not a manual refetch', async () => {
    const user = userEvent.setup();
    let rosterCallCount = 0;
    let jobPollCount = 0;
    installMockFetch([
      WORKERS_ROUTE,
      {
        method: 'GET',
        match: '/api/rosters/2026-08',
        respond: () => {
          rosterCallCount += 1;
          if (rosterCallCount === 1) return { status: 404, body: { message: 'Roster 2026-08 not found' } };
          return { status: 200, body: makeRoster() };
        },
      },
      { method: 'POST', match: '/api/rosters/generate', respond: () => ({ status: 202, body: { jobId: 'job-1' } }) },
      {
        method: 'GET',
        match: '/api/jobs/job-1',
        respond: () => {
          jobPollCount += 1;
          const base = { id: 'job-1', name: 'roster-generation' as const, createdAt: '2026-08-01T00:00:00.000Z' };
          if (jobPollCount < 2) {
            return { status: 200, body: { ...base, state: 'active', completedAt: null, result: null } };
          }
          return {
            status: 200,
            body: { ...base, state: 'completed', completedAt: '2026-08-01T00:01:00.000Z', result: { rosterId: 1, alertCount: 0 } },
          };
        },
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });

    const generateButton = await screen.findByRole('button', { name: 'Generate roster' });
    await user.click(generateButton);

    // The page never calls `refetch()` on `useGetRosterQuery` itself (see RosterPage.tsx) — the
    // grid can only show the generated roster if the `Roster` tag invalidation (jobs.api.ts,
    // fired when the job reaches `completed`) triggers RTK Query's own background refetch.
    expect(await screen.findByText('Dana Levi', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(rosterCallCount).toBeGreaterThanOrEqual(2);
  });

  it('blocks a manual add on a 422 hard-rule violation with a single-OK notice, and returns focus to the originating grid cell', async () => {
    const user = userEvent.setup();
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      STAFFING_REQUIREMENTS_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: makeRoster() }) },
      {
        method: 'POST',
        match: /^\/api\/shifts\/10\/workers$/,
        respond: () => ({
          status: 422,
          body: { violations: [{ code: 'maxTwoShiftsPerDay', detail: { message: 'Worker would have more than 2 shifts on 2026-08-01' } }] },
        }),
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const cell = await screen.findByTestId('cal-cell-2026-08-01-A');

    await user.click(cell);
    // Clicking the cell opens the dialog and (per Modal's focus trap) immediately moves focus
    // into it — the interesting invariant is what happens once the whole interaction concludes
    // (asserted below), not that focus stays put mid-interaction.

    const dialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });
    await within(dialog).findByRole('option', { name: /Omer Cohen/ });
    // Omer Cohen (worker id 2, seeded above) is GENERAL_GUARD, so his option lives in that role's
    // own picker — the "Add a worker" flow is now split into one section per role (see
    // `SlotEditDialog`'s role-grouped restructure).
    await user.selectOptions(within(dialog).getByLabelText('Add a General Guard'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Add General Guard' }));

    const blockedDialog = await screen.findByRole('dialog', { name: "Can't make this assignment" });
    expect(within(blockedDialog).getByText(/Worker would have more than 2 shifts/)).toBeInTheDocument();
    expect(within(blockedDialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    await user.click(within(blockedDialog).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Modal's focus trap (packages/ui) restores focus to whatever was active when it opened —
    // the grid cell that triggered the manual-edit dialog.
    expect(document.activeElement).toBe(cell);
  });

  it('offers a Save-anyway confirm on a 409 soft warning, and applies the change with ?confirm=true on accept', async () => {
    const user = userEvent.setup();
    let addCallCount = 0;
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      STAFFING_REQUIREMENTS_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: makeRoster() }) },
      {
        method: 'POST',
        match: /^\/api\/shifts\/10\/workers/,
        respond: (url) => {
          addCallCount += 1;
          if (url.search === '?confirm=true') {
            return { status: 201, body: { shiftId: 10, workerId: 2, role: 'GENERAL_GUARD', alerts: [] } };
          }
          return {
            status: 409,
            body: {
              warnings: [{ code: 'exceedsMaxMonthlyHours', detail: { message: 'Worker would have 190h, over the 186h contracted max' } }],
              confirmRequired: true,
            },
          };
        },
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const cell = await screen.findByTestId('cal-cell-2026-08-01-A');
    await user.click(cell);

    const dialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });
    await within(dialog).findByRole('option', { name: /Omer Cohen/ });
    await user.selectOptions(within(dialog).getByLabelText('Add a General Guard'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Add General Guard' }));

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm this assignment' });
    expect(within(confirmDialog).getByText(/over the 186h contracted max/)).toBeInTheDocument();

    await user.click(within(confirmDialog).getByRole('button', { name: 'Save anyway' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(addCallCount).toBe(2);
  });

  it('offers a confirm on a 409 soft warning when removing a worker, and applies the removal with ?confirm=true on accept', async () => {
    const user = userEvent.setup();
    let deleteCallCount = 0;
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      STAFFING_REQUIREMENTS_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: makeRoster() }) },
      {
        method: 'DELETE',
        match: /^\/api\/shifts\/10\/workers\/1/,
        respond: (url) => {
          deleteCallCount += 1;
          if (url.search === '?confirm=true') {
            return { status: 204 };
          }
          return {
            status: 409,
            body: {
              warnings: [
                { code: 'belowMinMonthlyHours', detail: { message: 'Worker would drop to 120h, under the 140h contracted min' } },
              ],
              confirmRequired: true,
            },
          };
        },
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const cell = await screen.findByTestId('cal-cell-2026-08-01-A');
    await user.click(cell);

    const dialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm this removal' });
    expect(within(confirmDialog).getByText(/under the 140h contracted min/)).toBeInTheDocument();

    await user.click(within(confirmDialog).getByRole('button', { name: 'Remove anyway' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleteCallCount).toBe(2);
  });

  it('declining a 409 remove confirm leaves the assignment untouched (no second DELETE call)', async () => {
    const user = userEvent.setup();
    let deleteCallCount = 0;
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      STAFFING_REQUIREMENTS_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: makeRoster() }) },
      {
        method: 'DELETE',
        match: /^\/api\/shifts\/10\/workers\/1/,
        respond: () => {
          deleteCallCount += 1;
          return {
            status: 409,
            body: {
              warnings: [{ code: 'belowMinMonthlyHours', detail: { message: 'Worker would drop below contracted min' } }],
              confirmRequired: true,
            },
          };
        },
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const cell = await screen.findByTestId('cal-cell-2026-08-01-A');
    await user.click(cell);

    const dialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm this removal' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }));

    // Back at the idle slot view, Dana Levi is still listed as assigned — nothing was applied.
    const idleDialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });
    expect(within(idleDialog).getByText('Dana Levi')).toBeInTheDocument();
    expect(deleteCallCount).toBe(1);
  });

  it('moves a worker between two slots as one action — the worker leaves the source and appears in the target', async () => {
    const user = userEvent.setup();
    let moveCallCount = 0;
    let rosterCallCount = 0;
    const rosterBeforeMove = makeRoster({
      shifts: [
        { id: 10, date: '2026-08-01', shiftType: 'A', assignments: [{ workerId: 1, name: 'Dana Levi', role: 'SUPERVISOR' }] },
        { id: 11, date: '2026-08-02', shiftType: 'A', assignments: [] },
      ],
    });
    const rosterAfterMove = makeRoster({
      shifts: [
        { id: 10, date: '2026-08-01', shiftType: 'A', assignments: [] },
        { id: 11, date: '2026-08-02', shiftType: 'A', assignments: [{ workerId: 1, name: 'Dana Levi', role: 'SUPERVISOR' }] },
      ],
    });
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      STAFFING_REQUIREMENTS_ROUTE,
      {
        method: 'GET',
        match: '/api/rosters/2026-08',
        respond: () => {
          rosterCallCount += 1;
          return { status: 200, body: rosterCallCount === 1 ? rosterBeforeMove : rosterAfterMove };
        },
      },
      {
        method: 'POST',
        match: /^\/api\/shifts\/10\/workers\/1\/move/,
        respond: () => {
          moveCallCount += 1;
          return { status: 200, body: { shiftId: 11, workerId: 1, role: 'SUPERVISOR', alerts: [] } };
        },
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const sourceCell = await screen.findByTestId('cal-cell-2026-08-01-A');
    await user.click(sourceCell);

    const dialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });
    await user.click(within(dialog).getByRole('button', { name: 'Move to…' }));

    const dateInput = within(dialog).getByLabelText('Target date');
    await user.clear(dateInput);
    await user.type(dateInput, '2026-08-02');

    await user.click(within(dialog).getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(moveCallCount).toBe(1);

    const targetCell = await screen.findByTestId('cal-cell-2026-08-02-A');
    await waitFor(() => expect(within(targetCell).getByText('Dana Levi')).toBeInTheDocument());
    expect(within(sourceCell).queryByText('Dana Levi')).not.toBeInTheDocument();
  });

  it('a move that triggers a 409 soft warning surfaces the same confirm state as add/remove, and resubmits with ?confirm=true', async () => {
    const user = userEvent.setup();
    let moveCallCount = 0;
    const roster = makeRoster({
      shifts: [
        { id: 10, date: '2026-08-01', shiftType: 'A', assignments: [{ workerId: 1, name: 'Dana Levi', role: 'SUPERVISOR' }] },
        { id: 11, date: '2026-08-02', shiftType: 'A', assignments: [] },
      ],
    });
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      STAFFING_REQUIREMENTS_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: roster }) },
      {
        method: 'POST',
        match: /^\/api\/shifts\/10\/workers\/1\/move/,
        respond: (url) => {
          moveCallCount += 1;
          if (url.search === '?confirm=true') {
            return { status: 200, body: { shiftId: 11, workerId: 1, role: 'SUPERVISOR', alerts: [] } };
          }
          return {
            status: 409,
            body: {
              warnings: [{ code: 'exceedsMaxMonthlyHours', detail: { message: 'Worker would exceed contracted max' } }],
              confirmRequired: true,
            },
          };
        },
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const sourceCell = await screen.findByTestId('cal-cell-2026-08-01-A');
    await user.click(sourceCell);

    const dialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });
    await user.click(within(dialog).getByRole('button', { name: 'Move to…' }));
    const dateInput = within(dialog).getByLabelText('Target date');
    await user.clear(dateInput);
    await user.type(dateInput, '2026-08-02');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));

    const confirmDialog = await screen.findByRole('dialog', { name: 'Confirm this move' });
    expect(within(confirmDialog).getByText(/exceed contracted max/)).toBeInTheDocument();
    await user.click(within(confirmDialog).getByRole('button', { name: 'Move anyway' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(moveCallCount).toBe(2);
  });

  it('shows the regenerate-published confirm dialog when the server reports reason: already-published', async () => {
    const user = userEvent.setup();
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: makeRoster() }) },
      {
        method: 'POST',
        match: '/api/rosters/generate',
        respond: () => ({
          status: 409,
          body: { message: 'Roster for 2026-08 is already published', reason: 'already-published' },
        }),
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const regenerateButton = await screen.findByRole('button', { name: 'Regenerate roster' });
    await user.click(regenerateButton);

    expect(await screen.findByRole('dialog', { name: 'Regenerate August 2026?' })).toBeInTheDocument();
  });

  it('does NOT show the regenerate-published dialog when the server reports reason: generation-in-progress, and surfaces a message instead', async () => {
    const user = userEvent.setup();
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: makeRoster() }) },
      {
        method: 'POST',
        match: '/api/rosters/generate',
        respond: () => ({
          status: 409,
          body: { message: 'A roster-generation job for 2026-08 is already in flight', reason: 'generation-in-progress' },
        }),
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const regenerateButton = await screen.findByRole('button', { name: 'Regenerate roster' });
    await user.click(regenerateButton);

    // A collision-prone "regenerate as draft" dialog would just 409 again — must not be offered.
    expect(await screen.findByText(/already running/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Regenerate August 2026?' })).not.toBeInTheDocument();
  });

  it('disables Publish until every alert is acknowledged, then enables it', async () => {
    const user = userEvent.setup();
    let acked = false;
    installMockFetch([
      WORKERS_ROUTE,
      {
        method: 'GET',
        match: '/api/rosters/2026-08',
        respond: () => ({
          status: 200,
          body: makeRoster({
            alerts: [
              {
                id: 5,
                type: 'UNFILLABLE_SLOT',
                detail: { date: '2026-08-06', shift: 'C', role: 'SUPERVISOR' },
                acknowledged: acked,
                acknowledgedAt: null,
              },
            ],
          }),
        }),
      },
      {
        method: 'POST',
        match: '/api/rosters/1/alerts/5/ack',
        respond: () => {
          acked = true;
          return {
            status: 200,
            body: { id: 5, type: 'UNFILLABLE_SLOT', detail: { date: '2026-08-06', shift: 'C', role: 'SUPERVISOR' }, acknowledged: true, acknowledgedAt: '2026-08-01T00:00:00.000Z' },
          };
        },
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const publishButton = await screen.findByRole('button', { name: 'Publish roster' });
    expect(publishButton).toBeDisabled();

    const ackCheckbox = screen.getByRole('checkbox', { name: /Acknowledge/ });
    await user.click(ackCheckbox);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish roster' })).toBeEnabled());
    expect(screen.getByText('✓ All clear — ready to publish')).toBeInTheDocument();
  });

  it('switches to the Availability tab and renders the availability grid instead of the roster calendar', async () => {
    const user = userEvent.setup();
    installMockFetch([
      WORKERS_ROUTE,
      AVAILABILITY_ROUTE,
      { method: 'GET', match: '/api/rosters/2026-08', respond: () => ({ status: 200, body: makeRoster() }) },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    await screen.findByRole('button', { name: 'Regenerate roster' });

    await user.click(screen.getByRole('tab', { name: 'Availability' }));

    expect(await screen.findByRole('table', { name: /availability grid/ })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /roster grid/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Export 2026-08 availability/ })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Roster grid' }));
    expect(await screen.findByRole('table', { name: /roster grid/ })).toBeInTheDocument();
  });

  it('groups the slot dialog by role with an "assigned X of Y required" count per role, and each role\'s picker only lists workers of that role', async () => {
    const user = userEvent.setup();
    const omer = makeWorker({ id: 2, name: 'Omer Cohen', role: 'GENERAL_GUARD' });
    const tal = makeWorker({ id: 3, nationalId: '111111118', name: 'Tal Regev', role: 'SUPERVISOR' });
    installMockFetch([
      { method: 'GET', match: /^\/api\/workers/, respond: () => ({ status: 200, body: [omer, tal] }) },
      {
        method: 'GET',
        match: '/api/availability/2026-08',
        respond: () => ({
          status: 200,
          body: {
            '2': { '2026-08-01': ['A', 'B', 'C'] },
            '3': { '2026-08-01': ['A', 'B', 'C'] },
          },
        }),
      },
      STAFFING_REQUIREMENTS_ROUTE,
      {
        method: 'GET',
        match: '/api/rosters/2026-08',
        respond: () => ({
          status: 200,
          body: makeRoster({
            shifts: [
              { id: 10, date: '2026-08-01', shiftType: 'A', assignments: [{ workerId: 1, name: 'Dana Levi', role: 'SUPERVISOR' }] },
            ],
          }),
        }),
      },
    ]);

    renderWithProviders(<RosterPage />, { initialEntries: ['/roster/2026-08'], path: '/roster/:month' });
    const cell = await screen.findByTestId('cal-cell-2026-08-01-A');
    await user.click(cell);

    const dialog = await screen.findByRole('dialog', { name: /2026-08-01 — Shift A/ });

    // The staffing requirement for shift A in this fixture is 2 General Guard / 1 Supervisor / 1
    // Screener (`STAFFING_REQUIREMENTS_ROUTE`); the roster has 1 Supervisor (Dana Levi) assigned
    // and nobody else — each role section's own count reflects only that role's assignments. The
    // count text comes from a separate query (`useListStaffingRequirementsQuery`) than the
    // roster's own assignments, so it can still be in flight right after the dialog mounts —
    // `findByText` (not `getByText`) waits for it; the count is split across sibling text nodes
    // ("Assigned ", "0", " of ", "2", " required"), so match on the whole node's `textContent`.
    const guardGroup = within(dialog).getByTestId('role-group-guard');
    expect(
      await within(guardGroup).findByText((_, el) => el?.textContent === 'Assigned 0 of 2 required'),
    ).toBeInTheDocument();
    expect(within(guardGroup).queryByText('Dana Levi')).not.toBeInTheDocument();

    const supervisorGroup = within(dialog).getByTestId('role-group-supervisor');
    expect(
      within(supervisorGroup).getByText((_, el) => el?.textContent === 'Assigned 1 of 1 required'),
    ).toBeInTheDocument();
    expect(within(supervisorGroup).getByText('Dana Levi')).toBeInTheDocument();

    const screenerGroup = within(dialog).getByTestId('role-group-screener');
    expect(
      within(screenerGroup).getByText((_, el) => el?.textContent === 'Assigned 0 of 1 required'),
    ).toBeInTheDocument();

    // Role-restricted pickers: Omer Cohen (GENERAL_GUARD) only ever appears as an option under the
    // General Guard section: never under Supervisor or Screener, where he'd be an invalid pick.
    expect(within(guardGroup).getByRole('option', { name: /Omer Cohen/ })).toBeInTheDocument();
    expect(within(supervisorGroup).queryByRole('option', { name: /Omer Cohen/ })).not.toBeInTheDocument();
    expect(within(screenerGroup).queryByRole('option', { name: /Omer Cohen/ })).not.toBeInTheDocument();

    // And symmetrically for Tal Regev (SUPERVISOR): only selectable under the Supervisor section.
    expect(within(supervisorGroup).getByRole('option', { name: /Tal Regev/ })).toBeInTheDocument();
    expect(within(guardGroup).queryByRole('option', { name: /Tal Regev/ })).not.toBeInTheDocument();
    expect(within(screenerGroup).queryByRole('option', { name: /Tal Regev/ })).not.toBeInTheDocument();

    // Each picker has its own uniquely-labeled select/id — no duplicate `id="slot-add-worker"`.
    expect(within(dialog).getByLabelText('Add a General Guard')).toHaveAttribute('id', 'slot-add-worker-guard');
    expect(within(dialog).getByLabelText('Add a Supervisor')).toHaveAttribute('id', 'slot-add-worker-supervisor');
    expect(within(dialog).getByLabelText('Add a Screener')).toHaveAttribute('id', 'slot-add-worker-screener');
  });
});
