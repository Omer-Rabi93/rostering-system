import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, EmptyState, Spinner, Table, type Column, type TableSort } from '@rostering/ui';
import type { Month } from '@rostering/shared';

import { useGetCostSummaryQuery } from '../../api/costSummary.api.js';
import { useListWorkersQuery } from '../../api/workers.api.js';
import { currentMonth } from '../../lib/calendar.js';
import { formatIls, formatMonthLong } from '../../lib/format.js';
import {
  buildCompanyCostRows,
  buildWorkerCostRows,
  computeCostStats,
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

const WORKER_COLUMNS: Column<WorkerCostRow>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'companyName', header: 'Company' },
  { key: 'role', header: 'Role', render: (row) => (row.role ? <Badge kind="role" value={row.role} /> : '—') },
  { key: 'shifts', header: 'Shifts', align: 'right' },
  { key: 'hours', header: 'Hours', align: 'right' },
  { key: 'costIls', header: 'Cost (ILS)', align: 'right', sortable: true, render: (row) => formatIls(row.costIls) },
];

export function CostDashboardPage(): ReactElement {
  const params = useParams<{ month: string }>();
  const navigate = useNavigate();
  const month: Month = params.month ?? currentMonth();

  const { data: summary, isLoading, isError } = useGetCostSummaryQuery(month);
  const { data: workers } = useListWorkersQuery();

  const [sort, setSort] = useState<TableSort>({ key: 'costIls', direction: 'desc' });

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

          <h2 style={{ marginTop: 'var(--space-6)' }}>By worker</h2>
          <Table<WorkerCostRow>
            columns={WORKER_COLUMNS}
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
