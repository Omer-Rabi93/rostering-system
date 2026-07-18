# Per-Company Rostering v3 — Global Active-Company Context — Implementation Plan

## Overview

v2 (branch `task/per-company-roster`, pending merge) made the backend correctly scope workers,
staffing requirements, and rosters per company, but exposed it in the UI as **three independent
`<Select>` dropdowns** copy-pasted into `RosterPage.tsx`, `RequirementsPage.tsx`, and
`CostDashboardPage.tsx` (local `useState`, defaults to `companies[0]`, no shared state). The user
has to re-pick the company on every page. This is a bad model for a single-tenant-per-session app
where a planner works within one company at a time.

v3 replaces the per-page filter with a **global "active company" concept**, chosen once (pick an
existing company or create a new one) the first time the app is opened, persisted across reloads,
changeable at any time via a switcher in the top bar, and consumed by every page as a guaranteed
non-null value — no more per-page loading/empty-state boilerplate.

**Key semantics (design decisions):**
- The active company is **client-only UI state** (matches this app's existing slice convention —
  see `dialogs.slice.ts`, `rosterEditor.slice.ts`), not server data. It lives in a new Redux slice,
  `activeCompany`, and is persisted to `localStorage` so it survives reloads. This is the **first**
  use of `localStorage` in this codebase (`grep -rn localStorage apps/ packages/` is currently
  empty) — treat the read/write helper as a new small convention, not a refactor of an existing one.
- **Every authenticated route is gated** behind having a valid active company selected — including
  `/companies`. If no company is active (first run, or the persisted id no longer exists because it
  was deleted, or `localStorage` was cleared), the gate screen replaces the normal page content:
    - Zero companies exist → a create-only first-run screen (name field, submit) — company is used to originally onboard, so this cannot be skipped.
    - One or more companies exist but none is active → a picker (list of companies, click to
      activate) plus a "+ New company" action.
  `/schedule/:token` (`PublicSchedulePage`) stays completely outside this gate — it's the
  unauthenticated worker-facing public view and must not depend on the planner's active company or
  the Redux store's business-data slices at all (already true today — preserve it).
- Creating a company from **any** entry point (the first-run screen, the picker's "+ New company",
  or the existing `/companies` "+ New company" button) sets it as the active company. Rationale: if
  you just created a company you almost certainly want to work in it next; this also means the
  first-run flow and the existing `CompaniesPage` create flow can share one code path with one
  extra dispatch, not two divergent flows.
- Deleting the **active** company clears the active-company slice (and its `localStorage` entry) so
  the gate reappears on next render — you cannot be left pointed at a company that no longer exists.
  Deleting a non-active company is unaffected.
- Pages no longer read `companyId` as `number | undefined` and defend against it being absent. A new
  `useActiveCompanyId()` hook returns a guaranteed non-null `number`, backed by a React context that
  `Layout` only provides once it has confirmed (against the live `useListCompaniesQuery()` result)
  that the persisted/selected id is real. This removes the per-page `companiesLoading` spinner and
  "No companies yet" `EmptyState` block that's currently duplicated identically in `RosterPage.tsx`,
  `RequirementsPage.tsx`, and `CostDashboardPage.tsx` — that duplication moves into the gate, once.
- The switcher (top bar) lets the planner change the active company at any time without leaving the
  current page's month — switching just re-fetches that page's data for the new company.

## Requirements

- New `apps/web/src/store/activeCompany.slice.ts`: `createSlice` matching the existing style
  (doc comment on what the state does/doesn't hold, `PayloadAction<T>` reducers, a `selectActiveCompanyId(state): number | null` selector). Actions: `companySelected(id: number)`, `companyCleared()`. Initial state read once at module load from a small `readPersistedCompanyId()`/`writePersistedCompanyId()` helper pair (own file or co-located) — guard `JSON.parse`/`Number` failures by treating anything invalid as unset, never throw on a corrupt localStorage value.
- Wire the slice into `apps/web/src/store/index.ts`'s reducer map (alongside `rosterEditor`, `ackChecklist`, `dialogs`). Persistence write-back happens via `store.subscribe(...)` set up once where `createAppStore()`/the exported `store` singleton lives — write only when the value actually changes (compare against last-written value) to avoid redundant `localStorage.setItem` calls on unrelated state changes. Co-located `activeCompany.slice.test.ts` for the reducer/selector, same pattern as the other three slices.
- New `apps/web/src/components/ActiveCompanyGate.tsx` (name indicative — match whatever this codebase's component-naming convention prefers) that:
  - Calls `useListCompaniesQuery()` and `useAppSelector(selectActiveCompanyId)`.
  - Loading → existing `Spinner` pattern (match how the per-page selectors did it today, e.g. `RosterPage.tsx`'s current `companiesLoading` branch, before it's deleted).
  - If the selected id is set and present in the fetched list → render `children` wrapped in a new `ActiveCompanyContext.Provider` supplying that id.
  - Else → render the create-or-pick screen described above (reuse `CompanyFormModal`'s form fields/validation logic for the "create" path, but note `packages/ui`'s `Modal` has no non-dismissable mode — the first-run **empty-list** case must not be a `Modal` at all, just an inline full-page form, since it must not be closeable; the **picker** case, where companies already exist, may reuse `Modal`/`CompanyFormModal` for its "+ New company" sub-action since escaping back to the picker is fine there).
  - On successful create (in either sub-case) or on picking an existing company, dispatch `companySelected(id)`.
- `apps/web/src/hooks/useActiveCompanyId.ts` (or co-located with the context): exports the context and a hook that throws a clear error if called with no provider in the tree — this should never happen in practice since only `ActiveCompanyGate`-wrapped subtrees render pages, so a throw here means a real programming error, not a state to handle gracefully.
- `apps/web/src/components/Layout.tsx`: render `ActiveCompanyGate` around `{children}` (so `routes.tsx`'s existing `<Layout><SomePage /></Layout>` call sites need zero changes), and add a company switcher control into the `.topbar` flex row — active company name + a `Select` (reuse `packages/ui`'s `Select`) populated from the same `useListCompaniesQuery()` list, `onChange` dispatches `companySelected`. Only render the switcher once a company is actually active (i.e., inside the gated branch, not in the gate screen itself — the gate screen has its own picker UI).
- `CompaniesPage.tsx`: on successful create, dispatch `companySelected(newId)` in addition to its existing close-modal logic. On successful delete, if `deletedId === activeCompanyId`, dispatch `companyCleared()`.
- Simplify `RosterPage.tsx`, `RequirementsPage.tsx`, `CostDashboardPage.tsx`, and `SlotEditDialog.tsx`:
  remove the local `useListCompaniesQuery`/`useState<number|undefined>`/`<Select>`/`companiesLoading`/`EmptyState("No companies yet")` block from each (four near-identical deletions), replace every use of the old `companyId` variable with `useActiveCompanyId()`. `SlotEditDialog`'s `companyId` prop can be dropped in favor of calling the hook directly inside it, removing one prop-drilling hop from `RosterPage`.
- Tests: update/replace each touched page's existing tests that assumed a company `<Select>` (`RosterPage.test.tsx`, `RequirementsPage.test.tsx`, `CostDashboardPage.test.tsx`) to instead wrap the rendered tree in a test `Provider` with `activeCompany` pre-set (check `apps/web/src/testUtils/renderWithProviders.tsx` for the existing pattern of pre-seeding slice state in tests, extend it for this slice). Add new tests: `ActiveCompanyGate` renders create-only screen with zero companies, picker with 1+ companies and none active, passes through to children once active and valid, and re-shows the gate if the persisted id isn't in the live company list (simulating "company was deleted elsewhere"). `activeCompany.slice.test.ts` covers the reducer plus the persisted-read/write helper (mock `localStorage`, including a corrupt-value case). `CompaniesPage` delete test covers the "deleting the active company clears it" case.
- No backend changes — this is frontend-only, v2's API already takes `companyId` everywhere needed.
- Preserve every existing invariant: a11y (the gate/picker screens follow the same focus-management conventions as existing modals/empty-states — check `useFocusTrap` usage), no new `any`, `exactOptionalPropertyTypes` discipline for the slice's `number | null` state.

---

## Execution Strategy

Single frontend-only pass, no backend involvement, so this doesn't need the multi-phase
backend→frontend split v2/availability-v2 used. One agent, TDD where the codebase already has
co-located tests (slice, gate, page updates), can do it in one pass.

### Phase 1: Redux slice + persistence (TDD)
**Agent:** `general-purpose`

**Tasks:**
- [ ] `activeCompany.slice.ts` + `activeCompany.slice.test.ts`: reducer, selector, persisted-read/write helper with corrupt-value handling, following `dialogs.slice.ts`'s doc-comment and structure conventions exactly.
- [ ] Wire into `store/index.ts`'s reducer map + `store.subscribe` persistence write-back (dedup writes).

### Phase 2: Gate, context hook, and Layout switcher
**Agent:** `general-purpose`

**Tasks:**
- [ ] `ActiveCompanyContext` + `useActiveCompanyId()` hook (throws outside provider).
- [ ] `ActiveCompanyGate.tsx`: loading / create-only (zero companies, non-dismissable, no `Modal`) / picker-with-create (`Modal`-based `CompanyFormModal` reuse for the "+ New company" sub-action) / pass-through-with-provider branches, plus tests for each branch.
- [ ] `Layout.tsx`: wrap `{children}` in `ActiveCompanyGate`, add the top-bar switcher `Select` (only rendered in the gated/active branch).
- [ ] `CompaniesPage.tsx`: dispatch `companySelected` on create success, `companyCleared` on deleting the active company; add/extend tests for both.

### Phase 3: Page simplification
**Agent:** `general-purpose`

**Tasks:**
- [ ] `RosterPage.tsx`, `RequirementsPage.tsx`, `CostDashboardPage.tsx`, `SlotEditDialog.tsx`: delete the local company-select plumbing, switch to `useActiveCompanyId()`. Update each page's test file to seed the active-company provider/slice instead of interacting with a `<Select>`.
- [ ] `renderWithProviders.tsx` test util: extend to accept a pre-seeded active company id (and/or wrap with `ActiveCompanyContext.Provider` directly, whichever matches the existing seeding pattern for `rosterEditor`/`dialogs`/`ackChecklist` state).

### Phase 4: Verification
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all green (web package primarily; api/shared/ui untouched, should stay cache-hit).
- [ ] Manual smoke check (dev server) of: fresh load with zero companies → create-only screen → lands on the page with the new company active; reload → same company still active (persistence); switch via top-bar → page data changes to the new company; delete the active company from `/companies` → gate reappears.
