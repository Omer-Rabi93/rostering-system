import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { ConfirmDialog, EmptyState, Spinner, Table, Toast, ToastRegion, type Column } from '@rostering/ui';

import {
  useCreateCompanyMutation,
  useDeleteCompanyMutation,
  useListCompaniesQuery,
  useRenameCompanyMutation,
  type CompanyDto,
} from '../../api/companies.api.js';
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

  const [createCompany, createResult] = useCreateCompanyMutation();
  const [renameCompany, renameResult] = useRenameCompanyMutation();
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

  async function handleFormSubmit(name: string) {
    try {
      if (editingCompany) {
        await renameCompany({ id: editingCompany.id, body: { name } }).unwrap();
        pushToast('success', `"${name}" saved.`);
      } else {
        const created = await createCompany({ name }).unwrap();
        // Creating a company from any entry point (here, or ActiveCompanyGate's first-run/picker
        // "+ New company") sets it as the active company -- if you just created it you almost
        // certainly want to work in it next.
        dispatch(companySelected(created.id));
        pushToast('success', `"${name}" created.`);
      }
      closeForm();
    } catch {
      // Error is surfaced inline via createResult/renameResult.error below; nothing else to do.
    }
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

  const formError = editingCompany
    ? classifyMutationError(renameResult.error).kind === 'conflictMessage'
      ? `A company named "${editingCompany.name}" already exists.`
      : undefined
    : classifyMutationError(createResult.error).kind === 'conflictMessage'
      ? 'A company with this name already exists (names are case-insensitive).'
      : undefined;

  const columns: Column<CompanyRow>[] = [
    { key: 'name', header: 'Name', sortable: false },
    { key: 'workerCount', header: 'Workers', align: 'right' },
  ];

  return (
    <div className="page page--narrow">
      <div className="page-header">
        <div>
          <h1>Companies</h1>
          <p>
            The employer each worker belongs to — grouping and cost reporting only. Rostering
            always pools workers globally regardless of company.
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
                Rename
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
        mode={editingCompany ? 'edit' : 'create'}
        initialName={editingCompany?.name ?? ''}
        error={formError}
        submitting={createResult.isLoading || renameResult.isLoading}
        onSubmit={(name) => void handleFormSubmit(name)}
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
