import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ConfirmDialog, EmptyState, Spinner, Table, Toast, ToastRegion, type Column } from '@rostering/ui';

import { useDeleteCompanyMutation, useListCompaniesQuery, type CompanyDto } from '../../api/companies.api.js';
import { useListWorkersQuery } from '../../api/workers.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { useToasts } from '../../hooks/useToasts.js';
import { companyCleared, companySelected, selectActiveCompanyId } from '../../store/activeCompany.slice.js';
import { dialogClosed, dialogOpened, selectActiveDialog } from '../../store/dialogs.slice.js';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { CompanyFormModal } from './CompanyFormModal.js';

interface CompanyRow extends CompanyDto {
  readonly workerCount: number;
}

export function CompaniesPage(): ReactElement {
  const { data: companies, isLoading } = useListCompaniesQuery();
  // No dedicated "worker count per company" field in `GET /api/companies` (the API only schemas
  // the raw company row) — derived client-side from the full worker list rather than adding a new
  // backend endpoint, which Phase 9 isn't permitted to do.
  const { data: workers } = useListWorkersQuery();

  const [deleteCompany] = useDeleteCompanyMutation();

  const activeDialog = useAppSelector(selectActiveDialog);
  const activeCompanyId = useAppSelector(selectActiveCompanyId);
  const dispatch = useAppDispatch();
  const { toasts, pushToast, dismissToast } = useToasts();

  const [editingCompany, setEditingCompany] = useState<CompanyDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CompanyRow | null>(null);

  const workerCountByCompany = useMemo(() => {
    const counts = new Map<number, number>();
    for (const worker of workers ?? []) {
      counts.set(worker.companyId, (counts.get(worker.companyId) ?? 0) + 1);
    }
    return counts;
  }, [workers]);

  const rows: CompanyRow[] = useMemo(
    () =>
      (companies ?? []).map((company) => ({
        ...company,
        workerCount: workerCountByCompany.get(company.id) ?? 0,
      })),
    [companies, workerCountByCompany],
  );

  function openCreate() {
    setEditingCompany(null);
    dispatch(dialogOpened({ kind: 'companyForm' }));
  }

  function openEdit(company: CompanyDto) {
    setEditingCompany(company);
    dispatch(dialogOpened({ kind: 'companyForm', companyId: company.id }));
  }

  function closeForm() {
    dispatch(dialogClosed());
    setEditingCompany(null);
  }

  // Called by `CompanyFormModal` exactly once, only once BOTH the company and its
  // staffing-requirements matrix have saved successfully (see that component's doc comment for
  // the full create/edit submit sequencing and its post-creation-failure retry behavior).
  function handleSaved(saved: CompanyDto) {
    if (editingCompany) {
      pushToast('success', `"${saved.name}" saved. Staffing requirements updated.`);
    } else {
      // Creating a company from any entry point (here, or ActiveCompanyGate's first-run/picker
      // "+ New company") sets it as the active company -- if you just created it you almost
      // certainly want to work in it next.
      dispatch(companySelected(saved.id));
      pushToast('success', `"${saved.name}" created. Staffing requirements saved.`);
    }
    closeForm();
  }

  function requestDelete(row: CompanyRow) {
    setPendingDelete(row);
    if (row.workerCount > 0) {
      dispatch(dialogOpened({ kind: 'deleteCompanyBlocked', companyId: row.id }));
    } else {
      dispatch(dialogOpened({ kind: 'deleteCompanyConfirm', companyId: row.id }));
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteCompany(pendingDelete.id).unwrap();
      // Deleting the active company clears it so the gate reappears on next render -- never leave
      // the app pointed at a company that no longer exists. Deleting a non-active company is
      // unaffected.
      if (pendingDelete.id === activeCompanyId) {
        dispatch(companyCleared());
      }
      pushToast('success', `"${pendingDelete.name}" deleted.`);
      dispatch(dialogClosed());
      setPendingDelete(null);
    } catch (err) {
      const classified = classifyMutationError(err);
      if (classified.kind === 'conflictMessage') {
        dispatch(dialogOpened({ kind: 'deleteCompanyBlocked', companyId: pendingDelete.id }));
      } else {
        pushToast('error', 'Could not delete this company. Please try again.');
        dispatch(dialogClosed());
      }
    }
  }

  function cancelDeleteDialog() {
    dispatch(dialogClosed());
    setPendingDelete(null);
  }

  const columns: Column<CompanyRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: false,
      render: (row) => (
        <button
          type="button"
          onClick={() => openEdit(row)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: 'var(--color-brand-text)',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          {row.name}
        </button>
      ),
    },
    { key: 'workerCount', header: 'Workers', align: 'right' },
  ];

  return (
    <div className="page page--narrow">
      <div className="page-header">
        <div>
          <h1>Companies</h1>
          <p>
            The employer each worker belongs to. Every worker is assigned to exactly one company,
            and the topbar&apos;s company switcher scopes Workers, Roster, and Cost Dashboard to
            whichever one is currently active — switching companies there changes what all of
            those pages show. Each company&apos;s staffing requirements (required headcount per
            role × shift) are edited alongside its name below.
          </p>
        </div>
        <button className="btn btn--primary" type="button" onClick={openCreate}>
          + New company
        </button>
      </div>

      {isLoading ? (
        <Spinner label="Loading companies" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<span aria-hidden="true">🏢</span>}
          title="No companies yet"
          body="Companies group workers by employer for cost reporting. Add at least one before creating workers, since every worker requires a company."
          action={{ label: '+ New company', onClick: openCreate }}
        />
      ) : (
        <Table<CompanyRow>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          caption={`${rows.length} ${rows.length === 1 ? 'company' : 'companies'}`}
          rowActions={(row) => (
            <>
              <button className="btn btn--secondary btn--sm" type="button" onClick={() => openEdit(row)}>
                Edit / Requirements
              </button>
              <button className="btn btn--danger btn--sm" type="button" onClick={() => requestDelete(row)}>
                Delete
              </button>
            </>
          )}
        />
      )}

      <CompanyFormModal
        isOpen={activeDialog?.kind === 'companyForm'}
        company={editingCompany}
        onSaved={handleSaved}
        onCancel={closeForm}
      />

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'deleteCompanyConfirm'}
        title={`Delete "${pendingDelete?.name ?? ''}"?`}
        body={<p>This company has no workers. This action can&apos;t be undone.</p>}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={cancelDeleteDialog}
      />

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'deleteCompanyBlocked'}
        title="Can't delete this company"
        body={
          <p>
            <strong>{pendingDelete?.name}</strong> still has {pendingDelete?.workerCount ?? 'some'}{' '}
            worker(s) assigned. Reassign or deactivate them before deleting this company.
          </p>
        }
        confirmLabel="OK"
        showCancel={false}
        onConfirm={cancelDeleteDialog}
        onCancel={cancelDeleteDialog}
      />

      <ToastRegion>
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            variant={toast.variant}
            message={toast.message}
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
      </ToastRegion>
    </div>
  );
}
