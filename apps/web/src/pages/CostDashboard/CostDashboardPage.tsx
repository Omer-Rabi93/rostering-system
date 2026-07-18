import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, EmptyState, Spinner, Table, type Column, type TableSort } from '@rostering/ui';
import type { Month } from '@rostering/shared';

import { useGetCostSummaryQuery } from '../../api/costSummary.api.js';
import { useListWorkersQuery } from '../../api/workers.api.js';
import { useActiveCompanyId } from '../../hooks/useActiveCompanyId.js';
import { currentMonth } from '../../lib/calendar.js';
import { formatIls, formatMonthLong } from '../../lib/format.js';
import { buildWorkerCostRows, computeCostStats, type WorkerCostRow } from './aggregate.js';

// Built per-render (not a module-level constant) because the worker-name column's link target
// depends on the page's current `:month` param, and the leading checkbox column's rendered
// state/handler depend on the page's `selectedWorkerIds` selection state.
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

  // Company-scoped rostering: a cost summary is derived from one company's roster, not a global
  // one. `ActiveCompanyGate` (via `Layout`) guarantees a valid company is active before this page
  // ever renders, so `companyId` is a plain non-null `number` here. There is no more "All
  // companies" view or per-page company filter — the switcher in the top bar is the one place to
  // change which company's dashboard you're looking at.
  const companyId = useActiveCompanyId();

  const { data: summary, isLoading, isError } = useGetCostSummaryQuery({ companyId, month });
  const { data: workers } = useListWorkersQuery({ companyId });

  const [sort, setSort] = useState<TableSort>({ key: 'costIls', direction: 'desc' });

  // Multi-select for the "Compare workers" feature — transient UI state scoped to building up a
  // selection before navigating to the compare page, not something worth persisting anywhere: the
  // resulting `/cost/:month/compare?workers=...` URL is what's bookmarkable.
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
