import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Badge, EmptyState, Spinner, Table, type Column } from '@rostering/ui';
import type { Month } from '@rostering/shared';

import { useListCompaniesQuery } from '../../api/companies.api.js';
import { useGetRosterQuery } from '../../api/rosters.api.js';
import { useGetWorkerContractQuery, useListWorkersQuery, type WorkerDto } from '../../api/workers.api.js';
import { useActiveCompanyId } from '../../hooks/useActiveCompanyId.js';
import { currentMonth } from '../../lib/calendar.js';
import { formatIls, formatMonthLong } from '../../lib/format.js';
import { SHIFT_ROW_COLUMNS } from './WorkerCostDetailPage.js';
import {
  buildWorkerComparisonRows,
  buildWorkerShiftRows,
  type WorkerComparisonInput,
  type WorkerComparisonRow,
} from './workerShiftBreakdown.js';

/** Parses the `?workers=1,2,3` search param into distinct positive integer worker ids, dropping
 * anything that doesn't parse (blank, non-numeric, zero/negative). Order-preserving and
 * duplicate-free, so `?workers=2,1,2` yields `[2, 1]`. */
function parseWorkerIds(raw: string | null): number[] {
  const seen = new Set<number>();
  for (const part of (raw ?? '').split(',')) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0) seen.add(id);
  }
  return [...seen];
}

// Built per-render because the Name column's link target depends on the page's `:month` param —
// same reasoning as `CostDashboardPage`'s `workerColumns`.
function comparisonColumns(month: Month): Column<WorkerComparisonRow>[] {
  return [
    {
      key: 'name',
      header: 'Name',
      render: (row) => <Link to={`/cost/${month}/worker/${row.workerId}`}>{row.name}</Link>,
    },
    { key: 'companyName', header: 'Company' },
    { key: 'totalShifts', header: 'Shifts', align: 'right' },
    { key: 'totalHours', header: 'Hours', align: 'right' },
    { key: 'totalCostIls', header: 'Cost (ILS)', align: 'right', render: (row) => formatIls(row.totalCostIls) },
  ];
}

interface WorkerCompareCardProps {
  readonly month: Month;
  readonly worker: WorkerDto;
  readonly companyName: string;
  readonly roster: Parameters<typeof buildWorkerShiftRows>[0];
  readonly onStats: (input: WorkerComparisonInput) => void;
}

/**
 * One worker's card on the compare page: same stat-tile + shift-table derivation as
 * `WorkerCostDetailPage` (`buildWorkerShiftRows` over the shared `roster` × this worker's own
 * `useGetWorkerContractQuery` rate), so a worker's numbers here can never disagree with their
 * single-worker detail page.
 *
 * Split into its own component (rather than the parent looping `useGetWorkerContractQuery` once
 * per selected worker id) because the number of selected workers varies across renders whenever
 * the `?workers=` URL param changes — calling a variable number of hooks in one component body
 * violates the rules of hooks. Each `WorkerCompareCard` instance always calls the same fixed set
 * of hooks; only the number of *instances* varies, which is ordinary list rendering.
 *
 * Reports its raw `WorkerComparisonInput` (id/name/company/role + shift rows) up to the parent
 * via `onStats` rather than a pre-reduced totals row, so `buildWorkerComparisonRows` is the ONE
 * place shifts/hours/cost get summed — both this card's own stat tiles and the parent's combined
 * summary table run the same rows through it, rather than two independent reductions that could
 * drift apart.
 */
function WorkerCompareCard({ month, worker, companyName, roster, onStats }: WorkerCompareCardProps): ReactElement {
  const { data: contract, isLoading: contractLoading } = useGetWorkerContractQuery(worker.id);
  const hourlyRate = contract?.hourlyCostIls ?? 0;

  const rows = useMemo(
    () => (roster ? buildWorkerShiftRows(roster, worker.id, hourlyRate) : []),
    [roster, worker.id, hourlyRate],
  );

  const [totals] = buildWorkerComparisonRows([
    { workerId: worker.id, name: worker.name, companyName, role: worker.role, rows },
  ]);

  // Reports up once the contract fetch has settled (a still-loading contract would momentarily
  // report a stale/zero rate). `onStats` is a `useCallback`'d stable function (see the parent), so
  // this only re-fires when `rows` itself actually changes, not on every parent re-render.
  useEffect(() => {
    if (contractLoading) return;
    onStats({ workerId: worker.id, name: worker.name, companyName, role: worker.role, rows });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractLoading, worker.id, worker.name, worker.role, companyName, rows]);

  return (
    <div className="card">
      <h3>
        <Link to={`/cost/${month}/worker/${worker.id}`}>{worker.name}</Link>
      </h3>
      <p>
        <Badge kind="role" value={worker.role} /> {companyName}
      </p>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="stat-tile__label">Shifts</div>
          <div className="stat-tile__value">{totals?.totalShifts ?? 0}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">Hours</div>
          <div className="stat-tile__value">{totals?.totalHours ?? 0}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile__label">Cost</div>
          <div className="stat-tile__value">{formatIls(totals?.totalCostIls ?? 0)}</div>
        </div>
      </div>

      <Table
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

/**
 * Side-by-side comparison of 2+ workers for a month, reached from the Cost Dashboard's "By
 * worker" table by checking 2 or more workers and clicking "Compare N workers". The selection
 * travels as `/cost/:month/compare?workers=<comma-separated-ids>` so the comparison itself is
 * bookmarkable/shareable, consistent with how the dashboard's own `?company=` filter works.
 *
 * Every number here — the combined summary table AND each worker's card — is derived from the
 * same `buildWorkerShiftRows` source `WorkerCostDetailPage` uses (not a second read of
 * `useGetCostSummaryQuery`), so this page's numbers can never disagree with a worker's own detail
 * page. The combined table is built by reducing each card's already-computed rows via
 * `buildWorkerComparisonRows` (see `workerShiftBreakdown.ts`).
 */
export function WorkerCostComparePage(): ReactElement {
  const params = useParams<{ month: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const month: Month = params.month ?? currentMonth();

  const workerIds = parseWorkerIds(searchParams.get('workers'));

  // Company-scoped rostering: `ActiveCompanyGate` (via `Layout`) guarantees a valid company is
  // active before this page ever renders.
  const companyId = useActiveCompanyId();

  const { data: roster, isLoading: rosterLoading, isError: rosterError } = useGetRosterQuery({ companyId, month });
  const { data: workers, isLoading: workersLoading } = useListWorkersQuery({ companyId });
  const { data: companies, isLoading: companiesLoading } = useListCompaniesQuery();

  // Keyed by workerId so each `WorkerCompareCard`'s report only ever overwrites its own slot.
  const [inputsById, setInputsById] = useState<Record<number, WorkerComparisonInput>>({});
  const handleStats = useCallback((input: WorkerComparisonInput) => {
    setInputsById((prev) => ({ ...prev, [input.workerId]: input }));
  }, []);

  // Fewer than 2 worker ids in the URL at all (hand-edited down to 0/1, or the param is missing)
  // — comparing a single worker is just the existing detail page, so this is a distinct "can't
  // compare" state rather than silently rendering a broken/degenerate one-card comparison.
  if (workerIds.length < 2) {
    return (
      <div className="page">
        <EmptyState
          icon={<span aria-hidden="true">⚖️</span>}
          title="Select at least 2 workers to compare"
          body="Pick two or more workers from the Cost Dashboard's By worker table (using the checkbox column), then click Compare."
          action={{ label: 'Back to Cost Dashboard', onClick: () => void navigate(`/cost/${month}`) }}
        />
      </div>
    );
  }

  const isLoading = rosterLoading || workersLoading || companiesLoading;

  if (isLoading) {
    return (
      <div className="page">
        <Spinner label="Loading worker comparison" />
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

  const companyNameById = new Map((companies ?? []).map((c) => [c.id, c.name]));
  const resolved = workerIds.map((id) => ({ id, worker: workers?.find((w) => w.id === id) }));
  const missingIds = resolved.filter((r) => !r.worker).map((r) => r.id);
  const foundWorkers = resolved
    .filter((r): r is { id: number; worker: WorkerDto } => r.worker !== undefined)
    .map((r) => ({ ...r, companyName: companyNameById.get(r.worker.companyId) ?? '—' }));

  const comparisonRows = buildWorkerComparisonRows(
    foundWorkers.map((f) => inputsById[f.id]).filter((input): input is WorkerComparisonInput => input !== undefined),
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Compare Workers — {formatMonthLong(month)}</h1>
          <p>Same shift-by-shift cost derivation as each worker&apos;s own detail page, side by side.</p>
        </div>
        <Link className="btn btn--secondary" to={`/cost/${month}`}>
          Back to Cost Dashboard
        </Link>
      </div>

      {missingIds.length > 0 ? (
        <p className="annotation" role="note">
          {missingIds.map((id) => `Worker #${id} not found`).join(', ')} — skipped from this comparison.
        </p>
      ) : null}

      {foundWorkers.length < 2 ? (
        <EmptyState
          icon={<span aria-hidden="true">⚖️</span>}
          title="Not enough workers to compare"
          body="At least 2 of the selected workers must still exist. Go back and pick a different set."
          action={{ label: 'Back to Cost Dashboard', onClick: () => void navigate(`/cost/${month}`) }}
        />
      ) : (
        <>
          <h2>Summary</h2>
          <Table<WorkerComparisonRow>
            columns={comparisonColumns(month)}
            rows={comparisonRows}
            rowKey={(row) => row.workerId}
            caption="Worker comparison summary, sorted by cost descending"
          />

          <h2 style={{ marginTop: 'var(--space-6)' }}>Details</h2>
          <div className="compare-grid">
            {foundWorkers.map(({ id, worker, companyName }) => (
              <WorkerCompareCard
                key={id}
                month={month}
                worker={worker}
                companyName={companyName}
                roster={roster}
                onStats={handleStats}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
