import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Badge, EmptyState, Select, Spinner, Table, type Column, type TableSort } from '@rostering/ui';
import type { Month } from '@rostering/shared';

import { useGetCostSummaryQuery } from '../../api/costSummary.api.js';
import { useListCompaniesQuery } from '../../api/companies.api.js';
import { useListWorkersQuery } from '../../api/workers.api.js';
import { currentMonth } from '../../lib/calendar.js';
import { formatIls, formatMonthLong } from '../../lib/format.js';
import {
  buildCompanyCostRows,
  buildWorkerCostRows,
  computeCostStats,
  filterCostSummaryByCompany,
  type CompanyCostRow,
  type WorkerCostRow,
} from './aggregate.js';

const COMPANY_COLUMNS: Column<CompanyCostRow>[] = [
  { key: 'companyName', header: 'Company' },
  { key: 'workers', header: 'Workers', align: 'right' },
  { key: 'shifts', header: 'Shifts', align: 'right' },
  { key: 'hours', header: 'Hours', align: 'right' },
  { key: 'costIls', header: 'Cost (ILS)', align: 'right', render: (row) => formatIls(row.costIls) },
];

// Built per-render (not a module-level constant, unlike COMPANY_COLUMNS) because the worker-name
// column's link target depends on the page's current `:month` param, and the leading checkbox
// column's rendered state/handler depend on the page's `selectedWorkerIds` selection state.
//
// The checkbox column is a distinct, non-data column prepended to the array (not a repurposed
// data column) — it reuses the `workerId` key only to satisfy `Column<T>.key`'s `keyof T & string`
// constraint (see Table.tsx's design note); its `render` ignores the raw cell value entirely.
function workerColumns(
  month: Month,
  selectedWorkerIds: ReadonlySet<number>,
  onToggleWorker: (workerId: number) => void,
): Column<WorkerCostRow>[] {
  return [
    {
      key: 'workerId',
      header: 'Compare',
      render: (row) => (
        <input
          type="checkbox"
          checked={selectedWorkerIds.has(row.workerId)}
          onChange={() => onToggleWorker(row.workerId)}
          aria-label={`Select ${row.name} for comparison`}
        />
      ),
    },
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (row) => <Link to={`/cost/${month}/worker/${row.workerId}`}>{row.name}</Link>,
    },
    { key: 'companyName', header: 'Company' },
    { key: 'role', header: 'Role', render: (row) => (row.role ? <Badge kind="role" value={row.role} /> : '—') },
    { key: 'shifts', header: 'Shifts', align: 'right' },
    { key: 'hours', header: 'Hours', align: 'right' },
    { key: 'costIls', header: 'Cost (ILS)', align: 'right', sortable: true, render: (row) => formatIls(row.costIls) },
  ];
}

export function CostDashboardPage(): ReactElement {
  const params = useParams<{ month: string }>();
  const navigate = useNavigate();
  const month: Month = params.month ?? currentMonth();

  // The company filter is persisted as a `?company=<id>` URL search param (rather than local
  // `useState`) so the filtered view is bookmarkable/shareable and consistent with the month
  // already living in the URL path. Absent/empty means "All companies".
  const [searchParams, setSearchParams] = useSearchParams();
  const companyParam = searchParams.get('company') ?? '';
  const selectedCompanyId = companyParam ? Number(companyParam) : null;

  const { data: rawSummary, isLoading, isError } = useGetCostSummaryQuery(month);
  const { data: workers } = useListWorkersQuery();
  const { data: companies } = useListCompaniesQuery();

  const [sort, setSort] = useState<TableSort>({ key: 'costIls', direction: 'desc' });

  // Multi-select for the "Compare workers" feature — deliberately local `useState` (unlike the
  // company filter) rather than a URL param: it's transient UI state scoped to building up a
  // selection before navigating to the compare page, not something worth bookmarking on the
  // dashboard itself (the resulting `/cost/:month/compare?workers=...` URL is what's bookmarkable).
  const [selectedWorkerIds, setSelectedWorkerIds] = useState<Set<number>>(new Set());

  function handleToggleWorker(workerId: number) {
    setSelectedWorkerIds((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) {
        next.delete(workerId);
      } else {
        next.add(workerId);
      }
      return next;
    });
  }

  const summary = useMemo(
    () => (rawSummary ? filterCostSummaryByCompany(rawSummary, workers ?? [], selectedCompanyId) : undefined),
    [rawSummary, workers, selectedCompanyId],
  );

  const companyRows = useMemo(
    () => (summary ? buildCompanyCostRows(summary, workers ?? []) : []),
    [summary, workers],
  );
  const workerRows = useMemo(() => {
    const rows = summary ? buildWorkerCostRows(summary, workers ?? []) : [];
    const sorted = [...rows].sort((a, b) => {
      const key = sort.key as keyof WorkerCostRow;
      const av = a[key];
      const bv = b[key];
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [summary, workers, sort]);

  const stats = summary ? computeCostStats(summary) : null;

  function handleCompanyChange(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set('company', value);
    } else {
      next.delete('company');
    }
    setSearchParams(next);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Cost Dashboard — {formatMonthLong(month)}</h1>
          <p>
            Projected labor cost computed at read time from shift assignments: hours = shifts × 8,
            cost = hours × hourly rate. Read-only — no editing here.
          </p>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label visually-hidden" htmlFor="cost-company">
            Company
          </label>
          <Select
            id="cost-company"
            value={companyParam}
            options={[
              { value: '', label: 'All companies' },
              ...(companies ?? []).map((c) => ({ value: String(c.id), label: c.name })),
            ]}
            onChange={(e) => handleCompanyChange(e.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label visually-hidden" htmlFor="cost-month">
            Month
          </label>
          <input
            id="cost-month"
            className="field__input"
            type="month"
            value={month}
            onChange={(e) => {
              if (e.target.value) void navigate(`/cost/${e.target.value}`);
            }}
          />
        </div>
      </div>

      {isLoading ? (
        <Spinner label="Loading cost summary" />
      ) : isError || !summary || !stats ? (
        <EmptyState
          icon={<span aria-hidden="true">💰</span>}
          title={`No cost data for ${formatMonthLong(month)}`}
          body="Cost is computed from a generated roster's assignments. Generate this month's roster first."
          action={{ label: 'Go to Roster', onClick: () => void navigate(`/roster/${month}`) }}
        />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="stat-tile__label">Roster total ({formatMonthLong(month)})</div>
              <div className="stat-tile__value">{formatIls(stats.totalIls)}</div>
              <div className="stat-tile__sub">
                {stats.totalShifts} shifts · {stats.totalHours} hours · {stats.totalWorkers} workers
              </div>
            </div>
            <div className="stat-tile">
              <div className="stat-tile__label">Avg. cost per shift</div>
              <div className="stat-tile__value">{formatIls(stats.avgCostPerShift)}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-tile__label">Avg. cost per worker</div>
              <div className="stat-tile__value">{formatIls(stats.avgCostPerWorker)}</div>
            </div>
          </div>

          {selectedCompanyId === null ? (
            <>
              <h2>By company</h2>
              <Table<CompanyCostRow>
                columns={COMPANY_COLUMNS}
                rows={companyRows}
                rowKey={(row) => row.companyId}
                caption="Cost by company"
                footer={
                  <tr>
                    <td>Total</td>
                    <td className="num">{stats.totalWorkers}</td>
                    <td className="num">{stats.totalShifts}</td>
                    <td className="num">{stats.totalHours}</td>
                    <td className="num">{formatIls(stats.totalIls)}</td>
                  </tr>
                }
              />
            </>
          ) : null}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 'var(--space-6)',
            }}
          >
            <h2 style={{ margin: 0 }}>By worker</h2>
            {selectedWorkerIds.size >= 2 ? (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() =>
                  void navigate(`/cost/${month}/compare?workers=${[...selectedWorkerIds].join(',')}`)
                }
              >
                Compare {selectedWorkerIds.size} workers
              </button>
            ) : null}
          </div>
          <Table<WorkerCostRow>
            columns={workerColumns(month, selectedWorkerIds, handleToggleWorker)}
            rows={workerRows}
            rowKey={(row) => row.workerId}
            caption="Per-worker cost breakdown, sorted by cost descending"
            sort={sort}
            onSortChange={(key) =>
              setSort((prev) => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }))
            }
          />
        </>
      )}
    </div>
  );
}
