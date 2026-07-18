import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, EmptyState, Spinner, Table, type Column } from '@rostering/ui';
import type { Month } from '@rostering/shared';

import { useListCompaniesQuery } from '../../api/companies.api.js';
import { useGetRosterQuery } from '../../api/rosters.api.js';
import { useGetWorkerContractQuery, useListWorkersQuery } from '../../api/workers.api.js';
import { useActiveCompanyId } from '../../hooks/useActiveCompanyId.js';
import { currentMonth } from '../../lib/calendar.js';
import { formatDayLabel, formatIls, formatMonthLong } from '../../lib/format.js';
import { buildWorkerShiftRows, type WorkerShiftRow } from './workerShiftBreakdown.js';

// Exported so `WorkerCostComparePage` (each per-worker card renders the same shift breakdown
// table) reuses this exact column definition rather than redeclaring it.
export const SHIFT_ROW_COLUMNS: Column<WorkerShiftRow>[] = [
  { key: 'date', header: 'Date', render: (row) => formatDayLabel(row.date) },
  { key: 'shiftType', header: 'Shift', render: (row) => <Badge kind="shift" value={row.shiftType} /> },
  { key: 'hours', header: 'Hours', align: 'right' },
  { key: 'costIls', header: 'Cost (ILS)', align: 'right', render: (row) => formatIls(row.costIls) },
];

/**
 * Per-worker cost detail for a single month, reached by clicking a worker's name on the Cost
 * Dashboard's "By worker" table. Everything here — stat tiles AND the shift table — is derived
 * from the SAME source (`useGetRosterQuery`'s shift assignments × `useGetWorkerContractQuery`'s
 * rate, via `buildWorkerShiftRows`) rather than also reading `useGetCostSummaryQuery`'s
 * `perWorker` row, so the two can never disagree.
 */
export function WorkerCostDetailPage(): ReactElement {
  const params = useParams<{ month: string; workerId: string }>();
  const navigate = useNavigate();
  const month: Month = params.month ?? currentMonth();
  const workerId = Number(params.workerId);

  // Company-scoped rostering: `ActiveCompanyGate` (via `Layout`) guarantees a valid company is
  // active before this page ever renders.
  const companyId = useActiveCompanyId();

  const { data: roster, isLoading: rosterLoading, isError: rosterError } = useGetRosterQuery({ companyId, month });
  const { data: workers, isLoading: workersLoading } = useListWorkersQuery({ companyId });
  const { data: companies, isLoading: companiesLoading } = useListCompaniesQuery();
  // A worker with no contract on file 404s here — that's a valid state (costSummaryService
  // itself treats "no contract" as a 0 rate, not an error), so its loading/error split below
  // only blocks on `isLoading`, not `isError`.
  const { data: contract, isLoading: contractLoading } = useGetWorkerContractQuery(workerId, {
    skip: !Number.isFinite(workerId),
  });

  const worker = workers?.find((w) => w.id === workerId);
  const company = companies?.find((c) => c.id === worker?.companyId);
  const hourlyRate = contract?.hourlyCostIls ?? 0;

  const rows = useMemo(
    () => (roster ? buildWorkerShiftRows(roster, workerId, hourlyRate) : []),
    [roster, workerId, hourlyRate],
  );

  const isLoading = rosterLoading || workersLoading || companiesLoading || contractLoading;

  if (isLoading) {
    return (
      <div className="page">
        <Spinner label="Loading worker cost detail" />
      </div>
    );
  }

  if (rosterError || !roster) {
    return (
      <div className="page">
        <EmptyState
          icon={<span aria-hidden="true">💰</span>}
          title={`No cost data for ${formatMonthLong(month)}`}
          body="Cost is computed from a generated roster's assignments. Generate this month's roster first."
          action={{ label: 'Go to Roster', onClick: () => void navigate(`/roster/${month}`) }}
        />
      </div>
    );
  }

  if (!worker) {
    return (
      <div className="page">
        <EmptyState
          icon={<span aria-hidden="true">🔍</span>}
          title="Worker not found"
          body="This worker doesn't exist, or may have been removed."
          action={{ label: 'Back to Cost Dashboard', onClick: () => void navigate(`/cost/${month}`) }}
        />
      </div>
    );
  }

  const totalShifts = rows.length;
  const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);
  const totalCostIls = rows.reduce((sum, r) => sum + r.costIls, 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>
            {worker.name} — {formatMonthLong(month)}
          </h1>
          <p>
            <Badge kind="role" value={worker.role} /> {company?.name ?? '—'}
          </p>
        </div>
        <Link className="btn btn--secondary" to={`/cost/${month}`}>
          Back to Cost Dashboard
        </Link>
      </div>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="stat-tile__label">Shifts</div>
          <div className="stat-tile__value">{totalShifts}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">Hours</div>
          <div className="stat-tile__value">{totalHours}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">Cost</div>
          <div className="stat-tile__value">{formatIls(totalCostIls)}</div>
        </div>
      </div>

      <h2>Shifts this month</h2>
      <Table<WorkerShiftRow>
        columns={SHIFT_ROW_COLUMNS}
        rows={rows}
        rowKey={(row) => row.shiftId}
        caption={`${worker.name}'s shifts for ${formatMonthLong(month)}`}
        emptyState={
          <EmptyState
            icon={<span aria-hidden="true">📭</span>}
            title="No shifts this month"
            body={`${worker.name} wasn't assigned any shifts in ${formatMonthLong(month)}.`}
          />
        }
      />
    </div>
  );
}
