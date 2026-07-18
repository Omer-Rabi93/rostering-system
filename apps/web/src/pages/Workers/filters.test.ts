import { describe, expect, it } from 'vitest';

import { ALL_VALUE, DEFAULT_WORKER_FILTERS, buildWorkerFilters, isDefaultFilters } from './filters.js';

describe('buildWorkerFilters', () => {
  it('defaults (status=ACTIVE, everything else ALL/empty) map to just { status: ACTIVE }', () => {
    expect(buildWorkerFilters(DEFAULT_WORKER_FILTERS)).toEqual({ status: 'ACTIVE' });
  });

  it('ALL_VALUE status is omitted entirely (not sent as a literal "ALL")', () => {
    expect(buildWorkerFilters({ ...DEFAULT_WORKER_FILTERS, status: ALL_VALUE })).toEqual({});
  });

  it('combines all four filters when every one is set', () => {
    expect(
      buildWorkerFilters({ status: 'INACTIVE', role: 'SUPERVISOR', companyId: '3', q: 'Dana' }),
    ).toEqual({ status: 'INACTIVE', role: 'SUPERVISOR', companyId: 3, q: 'Dana' });
  });

  it('trims whitespace-only search to omitted, and trims real search text', () => {
    expect(buildWorkerFilters({ ...DEFAULT_WORKER_FILTERS, q: '   ' })).toEqual({ status: 'ACTIVE' });
    expect(buildWorkerFilters({ ...DEFAULT_WORKER_FILTERS, q: '  Dana  ' })).toEqual({
      status: 'ACTIVE',
      q: 'Dana',
    });
  });

  it('an empty-string companyId (the unselected placeholder) is omitted, not sent as companyId=0', () => {
    expect(buildWorkerFilters({ ...DEFAULT_WORKER_FILTERS, companyId: '' })).toEqual({
      status: 'ACTIVE',
    });
  });
});

describe('isDefaultFilters', () => {
  it('is true for the default form state', () => {
    expect(isDefaultFilters(DEFAULT_WORKER_FILTERS)).toBe(true);
  });

  it('is false once any filter changes', () => {
    expect(isDefaultFilters({ ...DEFAULT_WORKER_FILTERS, q: 'x' })).toBe(false);
    expect(isDefaultFilters({ ...DEFAULT_WORKER_FILTERS, role: 'SCREENER' })).toBe(false);
    expect(isDefaultFilters({ ...DEFAULT_WORKER_FILTERS, status: ALL_VALUE })).toBe(false);
  });
});
