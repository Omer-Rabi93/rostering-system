import type { Role, WorkerStatus } from '@rostering/shared';

import type { WorkerListFilters } from '../../api/workers.api.js';

export const ALL_VALUE = 'ALL';

export interface WorkerFilterFormState {
  readonly status: WorkerStatus | typeof ALL_VALUE;
  readonly role: Role | typeof ALL_VALUE;
  readonly companyId: string; // Select value; '' or ALL_VALUE means "All companies"
  readonly q: string;
}

export const DEFAULT_WORKER_FILTERS: WorkerFilterFormState = {
  status: 'ACTIVE',
  role: ALL_VALUE,
  companyId: ALL_VALUE,
  q: '',
};

/** Maps the filter bar's UI form state (which uses an `ALL_VALUE` select sentinel and a
 * possibly-empty search box) onto the `WorkerListFilters` query-arg shape `useListWorkersQuery`
 * actually understands — `ALL_VALUE`/empty-string mean "omit this filter", not "match the literal
 * string ALL". Kept pure/testable rather than inlined into the page component, since combining
 * four independent filters correctly (including the empty-vs-omitted distinction) is exactly the
 * kind of logic worth unit-testing directly. */
export function buildWorkerFilters(form: WorkerFilterFormState): WorkerListFilters {
  return {
    ...(form.status !== ALL_VALUE ? { status: form.status } : {}),
    ...(form.role !== ALL_VALUE ? { role: form.role } : {}),
    ...(form.companyId !== ALL_VALUE && form.companyId !== ''
      ? { companyId: Number(form.companyId) }
      : {}),
    ...(form.q.trim() !== '' ? { q: form.q.trim() } : {}),
  };
}

export function isDefaultFilters(form: WorkerFilterFormState): boolean {
  return (
    form.status === DEFAULT_WORKER_FILTERS.status &&
    form.role === ALL_VALUE &&
    (form.companyId === ALL_VALUE || form.companyId === '') &&
    form.q.trim() === ''
  );
}
