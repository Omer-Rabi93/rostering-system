import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ConfirmDialog, JobProgress, Modal, Table, type Column } from '@rostering/ui';
import type { ImportResult } from '@rostering/shared';

import { EXPORT_WORKERS_CSV_URL, useImportWorkersCsvMutation } from '../../api/csv.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { useJobPolling } from '../../api/jobs.api.js';
import { dialogClosed, dialogOpened, selectActiveDialog } from '../../store/dialogs.slice.js';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';

interface RowError {
  readonly row: number;
  readonly nationalId: string;
  readonly field: string;
  readonly message: string;
}

const ERROR_COLUMNS: Column<RowError>[] = [
  { key: 'row', header: 'Row', align: 'right' },
  { key: 'nationalId', header: 'National ID' },
  { key: 'field', header: 'Field' },
  { key: 'message', header: 'Message' },
];

interface DeactivatedRow {
  readonly nationalId: string;
  readonly name: string;
}

const DEACTIVATED_COLUMNS: Column<DeactivatedRow>[] = [
  { key: 'nationalId', header: 'National ID' },
  { key: 'name', header: 'Name' },
];

/** The "Bulk import / export" card — part of the Workers page (see `WorkersPage.tsx`), not its
 * own route: the CSV panel operates on the exact same worker registry the rest of the page
 * displays, so keeping it on `/workers` (matching `docs/design/ui/mockups/01-workers.html`'s
 * layout) means an import's effect (new/updated/deactivated workers) is visible in the same list
 * a planner is already looking at, without navigating away. */
export function CsvPanel(): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [importError, setImportError] = useState<string | null>(null);

  const [importCsv, importResult] = useImportWorkersCsvMutation();
  const jobPoll = useJobPolling(jobId);

  const activeDialog = useAppSelector(selectActiveDialog);
  const dispatch = useAppDispatch();

  function handleFileChosen() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setConfirmChecked(false);
    setImportError(null);
    dispatch(dialogOpened({ kind: 'csvImportConfirm' }));
  }

  function cancelConfirm() {
    dispatch(dialogClosed());
    setPendingFile(null);
  }

  async function confirmImport() {
    if (!pendingFile) return;
    try {
      const { jobId: newJobId } = await importCsv(pendingFile).unwrap();
      setImportError(null);
      setJobId(newJobId);
      dispatch(dialogOpened({ kind: 'csvImportResult', jobId: newJobId }));
    } catch (err) {
      const classified = classifyMutationError(err);
      const message =
        classified.kind === 'badRequest'
          ? classified.body.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join(' ')
          : 'Could not import this file. Please check it and try again.';
      setImportError(message);
      dispatch(dialogClosed());
    }
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function closeResult() {
    dispatch(dialogClosed());
    setJobId(undefined);
  }

  // Narrowed by job `name`, not by structural shape: `ImportResult` (worker CSV) and
  // `AvailabilityImportResult` (Availability v2's month-scoped CSV, see `AvailabilityCsvPanel.tsx`)
  // now share the `totalRows` field, so a `'totalRows' in result` check alone no longer
  // distinguishes them — `AvailabilityImportResult` would satisfy it too and fail to narrow to
  // exactly `ImportResult`, since it's missing `inserted`/`updated`/`deactivated`.
  const jobResult: ImportResult | null =
    jobPoll.data?.state === 'completed' && jobPoll.data.name === 'csv-import' && jobPoll.data.result
      ? (jobPoll.data.result as ImportResult)
      : null;

  return (
    <div className="card">
      <div className="card__title">Bulk import / export</div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-secondary)' }}>
        Import is a <strong>full workforce sync</strong>: any existing worker whose national ID is
        absent from the uploaded file is set Inactive. A row present but failing validation is{' '}
        <em>not</em> deactivated.
      </p>
      {importError ? (
        <p className="warn-text" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{importError}</span>
        </p>
      ) : null}
      <div className="toolbar">
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label" htmlFor="csv-file">
            CSV file
          </label>
          <input
            id="csv-file"
            className="field__input"
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleFileChosen}
          />
        </div>
        <span className="spacer" />
        <a className="btn btn--secondary" href={EXPORT_WORKERS_CSV_URL}>
          Export current workers (.csv)
        </a>
      </div>

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'csvImportConfirm'}
        title="Confirm import — full workforce sync"
        body={
          <>
            <p className="warn-text">
              <span aria-hidden="true">⚠</span>
              <span>
                This file will become the authoritative worker list. <strong>Any existing worker
                whose national ID is not in this file will be set Inactive</strong> (never deleted
                — contract and shift history are kept). A row present in the file but failing
                validation will <em>not</em> be deactivated.
              </span>
            </p>
            <div className="field-checkbox">
              <input
                type="checkbox"
                id="csv-confirm-check"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              <label htmlFor="csv-confirm-check">
                I understand workers not in this file will be set Inactive.
              </label>
            </div>
          </>
        }
        confirmLabel={pendingFile ? `Import ${pendingFile.name}` : 'Import'}
        destructive
        confirmDisabled={!confirmChecked || importResult.isLoading}
        onConfirm={() => void confirmImport()}
        onCancel={cancelConfirm}
      />

      <Modal
        isOpen={activeDialog?.kind === 'csvImportResult'}
        onClose={closeResult}
        titleId="csv-result-title"
        title={jobResult ? 'Import complete' : 'Importing workers.csv'}
        size="lg"
        footer={
          <button type="button" className="btn btn--primary" onClick={closeResult}>
            {jobResult ? 'Done' : 'Run in background'}
          </button>
        }
      >
        {!jobResult ? (
          <JobProgress
            state={jobPoll.data?.state ?? 'created'}
            label={
              jobPoll.data?.state === 'failed'
                ? 'Import failed.'
                : `Importing ${pendingFile?.name ?? 'workers.csv'}…`
            }
            {...(jobPoll.data?.state === 'failed' ? { errorMessage: 'See server logs for details.' } : {})}
          />
        ) : (
          <>
            <div className="stat-grid" style={{ marginBottom: 'var(--space-5)' }}>
              <div className="stat-tile">
                <div className="stat-tile__label">Total rows</div>
                <div className="stat-tile__value">{jobResult.totalRows}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-tile__label">Inserted</div>
                <div className="stat-tile__value">{jobResult.inserted}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-tile__label">Updated</div>
                <div className="stat-tile__value">{jobResult.updated}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-tile__label">Failed</div>
                <div className="stat-tile__value">{jobResult.failed}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-tile__label">Deactivated</div>
                <div className="stat-tile__value">{jobResult.deactivated}</div>
              </div>
            </div>

            <h3>Row errors ({jobResult.errors.length})</h3>
            <Table<RowError>
              columns={ERROR_COLUMNS}
              rows={jobResult.errors.map((e) => ({
                row: e.row,
                nationalId: e.nationalId ?? '—',
                field: e.field ?? '—',
                message: e.message,
              }))}
              rowKey={(row) => row.row}
              caption={`${jobResult.errors.length} row errors`}
            />

            <h3 style={{ marginTop: 'var(--space-5)' }}>
              Deactivated workers ({jobResult.deactivatedWorkers.length})
            </h3>
            <p className="field__hint">
              Absent from this file — set Inactive automatically by the sync. Flip back to Active
              any time.
            </p>
            <Table<DeactivatedRow>
              columns={DEACTIVATED_COLUMNS}
              rows={jobResult.deactivatedWorkers.map((w) => ({ nationalId: w.nationalId, name: w.name }))}
              rowKey={(row) => row.nationalId}
              caption={`${jobResult.deactivatedWorkers.length} deactivated workers`}
            />
          </>
        )}
      </Modal>
    </div>
  );
}
