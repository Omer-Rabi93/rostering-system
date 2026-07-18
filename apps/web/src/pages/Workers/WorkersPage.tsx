import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Select,
  Spinner,
  Table,
  Toast,
  ToastRegion,
  type Column,
} from '@rostering/ui';
import { ROLES, WORKER_STATUSES } from '@rostering/shared';

import { useListCompaniesQuery } from '../../api/companies.api.js';
import {
  useDeleteWorkerMutation,
  useListWorkersQuery,
  useUpdateWorkerMutation,
  type WorkerDto,
} from '../../api/workers.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { formatIls } from '../../lib/format.js';
import { useToasts } from '../../hooks/useToasts.js';
import { dialogClosed, dialogOpened, selectActiveDialog } from '../../store/dialogs.slice.js';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { CsvPanel } from './CsvPanel.js';
import { ShareLinkModal } from './ShareLinkModal.js';
import { WorkerFormModal } from './WorkerFormModal.js';
import {
  ALL_VALUE,
  DEFAULT_WORKER_FILTERS,
  buildWorkerFilters,
  isDefaultFilters,
  type WorkerFilterFormState,
} from './filters.js';

const ROLE_LABEL: Record<(typeof ROLES)[number], string> = {
  GENERAL_GUARD: 'General Guard',
  SUPERVISOR: 'Supervisor',
  SCREENER: 'Screener',
};

export function WorkersPage(): ReactElement {
  const [filterForm, setFilterForm] = useState<WorkerFilterFormState>(DEFAULT_WORKER_FILTERS);
  const filters = useMemo(() => buildWorkerFilters(filterForm), [filterForm]);

  const { data: workers, isLoading } = useListWorkersQuery(filters);
  const { data: companies } = useListCompaniesQuery();

  const [deleteWorker] = useDeleteWorkerMutation();
  const [updateWorker] = useUpdateWorkerMutation();

  const activeDialog = useAppSelector(selectActiveDialog);
  const dispatch = useAppDispatch();
  const { toasts, pushToast, dismissToast } = useToasts();

  const [editingWorker, setEditingWorker] = useState<WorkerDto | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<WorkerDto | null>(null);
  const [shareLinkWorker, setShareLinkWorker] = useState<WorkerDto | null>(null);

  const companyName = useMemo(() => {
    const map = new Map((companies ?? []).map((c) => [c.id, c.name]));
    return (companyId: number) => map.get(companyId) ?? `#${companyId}`;
  }, [companies]);

  function openCreate() {
    setEditingWorker(null);
    dispatch(dialogOpened({ kind: 'workerForm' }));
  }

  function openEdit(worker: WorkerDto) {
    setEditingWorker(worker);
    dispatch(dialogOpened({ kind: 'workerForm', workerId: worker.id }));
  }

  function closeForm() {
    dispatch(dialogClosed());
    setEditingWorker(null);
  }

  function handleSaved() {
    pushToast('success', editingWorker ? `"${editingWorker.name}" saved.` : 'Worker created.');
    closeForm();
  }

  function openShareLink(worker: WorkerDto) {
    setShareLinkWorker(worker);
    dispatch(dialogOpened({ kind: 'shareLinkModal', workerId: worker.id }));
  }

  async function handleDelete(worker: WorkerDto) {
    try {
      await deleteWorker(worker.id).unwrap();
      pushToast('success', `"${worker.name}" deleted.`);
    } catch (err) {
      if (classifyMutationError(err).kind === 'conflictMessage') {
        setPendingDeactivate(worker);
        dispatch(dialogOpened({ kind: 'deactivateWorkerConfirm', workerId: worker.id }));
      } else {
        pushToast('error', 'Could not delete this worker. Please try again.');
      }
    }
  }

  async function confirmDeactivate() {
    if (!pendingDeactivate) return;
    try {
      await updateWorker({
        id: pendingDeactivate.id,
        body: {
          nationalId: pendingDeactivate.nationalId,
          name: pendingDeactivate.name,
          role: pendingDeactivate.role,
          status: 'INACTIVE',
          companyId: pendingDeactivate.companyId,
        },
      }).unwrap();
      pushToast('success', `"${pendingDeactivate.name}" set to Inactive.`);
    } catch {
      pushToast('error', 'Could not update this worker. Please try again.');
    } finally {
      dispatch(dialogClosed());
      setPendingDeactivate(null);
    }
  }

  const columns: Column<WorkerDto>[] = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'nationalId', header: 'National ID' },
    { key: 'companyId', header: 'Company', render: (row) => companyName(row.companyId) },
    { key: 'role', header: 'Role', render: (row) => <Badge kind="role" value={row.role} /> },
    { key: 'status', header: 'Status', render: (row) => <Badge kind="status" value={row.status} /> },
    {
      key: 'contract',
      header: 'Hourly cost',
      align: 'right',
      render: (row) => (row.contract ? formatIls(row.contract.hourlyCostIls) : '—'),
    },
    {
      key: 'id',
      header: 'Min/Max hrs',
      align: 'right',
      render: (row) =>
        row.contract ? `${row.contract.minMonthlyHours} / ${row.contract.maxMonthlyHours}` : '—',
    },
  ];

  const rows = workers ?? [];
  const isFiltered = !isDefaultFilters(filterForm);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Workers</h1>
          <p>Full registry of workers and their contracts. Inactive workers are kept for history but never appear in rostering.</p>
        </div>
        <button className="btn btn--primary" type="button" onClick={openCreate}>
          + New worker
        </button>
      </div>

      <div className="toolbar filters" role="search" aria-label="Filter workers">
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label" htmlFor="f-status">
            Status
          </label>
          <Select
            id="f-status"
            value={filterForm.status}
            options={[
              { value: ALL_VALUE, label: 'All' },
              ...WORKER_STATUSES.map((s) => ({ value: s, label: s === 'ACTIVE' ? 'Active' : 'Inactive' })),
            ]}
            onChange={(e) => setFilterForm((f) => ({ ...f, status: e.target.value as typeof f.status }))}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label" htmlFor="f-role">
            Role
          </label>
          <Select
            id="f-role"
            value={filterForm.role}
            options={[
              { value: ALL_VALUE, label: 'All roles' },
              ...ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })),
            ]}
            onChange={(e) => setFilterForm((f) => ({ ...f, role: e.target.value as typeof f.role }))}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label" htmlFor="f-company">
            Company
          </label>
          <Select
            id="f-company"
            value={filterForm.companyId}
            options={[
              { value: ALL_VALUE, label: 'All companies' },
              ...(companies ?? []).map((c) => ({ value: String(c.id), label: c.name })),
            ]}
            onChange={(e) => setFilterForm((f) => ({ ...f, companyId: e.target.value }))}
          />
        </div>
        <div className="field" style={{ marginBottom: 0, minWidth: '220px' }}>
          <label className="field__label" htmlFor="f-search">
            Search
          </label>
          <input
            id="f-search"
            className="field__input"
            type="search"
            placeholder="Name or national ID"
            value={filterForm.q}
            onChange={(e) => setFilterForm((f) => ({ ...f, q: e.target.value }))}
          />
        </div>
        {isFiltered ? (
          <button className="btn btn--secondary" type="button" onClick={() => setFilterForm(DEFAULT_WORKER_FILTERS)}>
            Clear filters
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <Spinner label="Loading workers" />
      ) : rows.length === 0 ? (
        isFiltered ? (
          <EmptyState
            icon={<span aria-hidden="true">🔍</span>}
            title="No workers match these filters"
            body="Try clearing a filter or search term. If you expect results, check the Status filter — inactive workers are hidden by default."
            action={{ label: 'Clear filters', onClick: () => setFilterForm(DEFAULT_WORKER_FILTERS) }}
          />
        ) : (
          <EmptyState
            icon={<span aria-hidden="true">👥</span>}
            title="No workers yet"
            action={{ label: '+ New worker', onClick: openCreate }}
          />
        )
      ) : (
        <Table<WorkerDto>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          caption={`${rows.length} ${rows.length === 1 ? 'worker' : 'workers'}`}
          rowActions={(row) => (
            <>
              <button className="btn btn--secondary btn--sm" type="button" onClick={() => openEdit(row)}>
                Edit
              </button>
              <button className="btn btn--ghost btn--sm" type="button" onClick={() => openShareLink(row)}>
                Share link
              </button>
              <button className="btn btn--danger btn--sm" type="button" onClick={() => void handleDelete(row)}>
                Delete
              </button>
            </>
          )}
        />
      )}

      <CsvPanel />

      <WorkerFormModal
        isOpen={activeDialog?.kind === 'workerForm'}
        worker={editingWorker}
        companies={companies ?? []}
        onSaved={handleSaved}
        onCancel={closeForm}
      />

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'deactivateWorkerConfirm'}
        title="Can't delete this worker"
        body={
          <p>
            {pendingDeactivate?.name} has shift history and can&apos;t be permanently deleted. Set
            them to <strong>Inactive</strong> instead — their contract and history are kept, and
            they&apos;re excluded from future rostering.
          </p>
        }
        confirmLabel="Set Inactive"
        onConfirm={() => void confirmDeactivate()}
        onCancel={() => {
          dispatch(dialogClosed());
          setPendingDeactivate(null);
        }}
      />

      <ShareLinkModal
        isOpen={activeDialog?.kind === 'shareLinkModal'}
        workerId={shareLinkWorker?.id ?? null}
        workerName={shareLinkWorker?.name ?? ''}
        onClose={() => {
          dispatch(dialogClosed());
          setShareLinkWorker(null);
        }}
      />

      <ToastRegion>
        {toasts.map((toast) => (
          <Toast key={toast.id} variant={toast.variant} message={toast.message} onDismiss={() => dismissToast(toast.id)} />
        ))}
      </ToastRegion>
    </div>
  );
}
