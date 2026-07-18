import type { Role, WorkerStatus } from '@rostering/shared';

import type { WorkerListFilters } from '../../api/workers.api.js';

export const ALL_VALUE = 'ALL';

/**
 * Company is deliberately NOT one of this page's own filters — `WorkersPage` is scoped to the
 * topbar's active company (`useActiveCompanyId()`) exactly like Requirements/Roster/Cost
 * Dashboard, not by an independent per-page "All companies" picker (removed; see the v4 topbar
 * company-scoping fix). `companyId` still exists on `WorkerListFilters` itself (the API-level
 * filter) — `WorkersPage` supplies it directly from `useActiveCompanyId()`, unconditionally,
 * rather than threading it through this form state.
 */
export interface WorkerFilterFormState {
  readonly status: WorkerStatus | typeof ALL_VALUE;
  readonly role: Role | typeof ALL_VALUE;
  readonly q: string;
}

export const DEFAULT_WORKER_FILTERS: WorkerFilterFormState = {
  status: 'ACTIVE',
  role: ALL_VALUE,
  q: '',
};

/** Maps the filter bar's UI form state (which uses an `ALL_VALUE` select sentinel and a
 * possibly-empty search box) onto the `WorkerListFilters` query-arg shape `useListWorkersQuery`
 * actually understands — `ALL_VALUE`/empty-string mean "omit this filter", not "match the literal
 * string ALL". Kept pure/testable rather than inlined into the page component, since combining
 * these filters correctly (including the empty-vs-omitted distinction) is exactly the kind of
 * logic worth unit-testing directly. Does NOT include `companyId` — the page adds that itself from
 * `useActiveCompanyId()`, always, not as an optional form field. */
export function buildWorkerFilters(form: WorkerFilterFormState): Omit<WorkerListFilters, 'companyId'> {
  return {
    ...(form.status !== ALL_VALUE ? { status: form.status } : {}),
    ...(form.role !== ALL_VALUE ? { role: form.role } : {}),
    ...(form.q.trim() !== '' ? { q: form.q.trim() } : {}),
  };
}

export function isDefaultFilters(form: WorkerFilterFormState): boolean {
  return (
    form.status === DEFAULT_WORKER_FILTERS.status &&
    form.role === ALL_VALUE &&
    form.q.trim() === ''
  );
}
