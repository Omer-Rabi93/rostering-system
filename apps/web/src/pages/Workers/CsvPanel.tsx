import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ConfirmDialog, JobProgress, Modal, Table, type Column } from '@rostering/ui';
import type { ImportResult } from '@rostering/shared';

import { EXPORT_WORKERS_CSV_URL, useImportWorkersCsvMutation } from '../../api/csv.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { useLazyGetActiveImportTaskQuery } from '../../api/importTasks.api.js';
import { useJobPolling } from '../../api/jobs.api.js';
import { useActiveCompanyId } from '../../hooks/useActiveCompanyId.js';
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

/** The "Bulk import / export" card — part of the Workers page (see `WorkersPage.tsx`), not its
 * own route: the CSV panel operates on the exact same worker registry the rest of the page
 * displays, so keeping it on `/workers` (matching `docs/design/ui/mockups/01-workers.html`'s
 * layout) means an import's effect (new/updated workers) is visible in the same list a planner is
 * already looking at, without navigating away.
 *
 * v4: the worker-CSV upload is scoped to the active company (`useActiveCompanyId()`), and the
 * global deactivation sweep is gone entirely — replaced by `Worker.lastImportTaskId`-based roster-
 * generation eligibility (see the v4 design doc, Part A), which has no UI surface of its own here.
 */
export function CsvPanel(): ReactElement {
  const companyId = useActiveCompanyId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [importError, setImportError] = useState<string | null>(null);

  const [importCsv, importResult] = useImportWorkersCsvMutation();
  const [checkActiveImportTask] = useLazyGetActiveImportTaskQuery();
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

  async function submitImport() {
    if (!pendingFile) return;
    try {
      const { jobId: newJobId } = await importCsv({ file: pendingFile, companyId }).unwrap();
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

  /**
   * v4 pre-upload check (design doc, Part A's Frontend section): before actually submitting,
   * check whether an import is already in flight for this company+kind. If so, gate the upload
   * behind a second confirm dialog rather than silently cancelling/replacing it out from under
   * whoever started it. This is a UX nicety, not the correctness guarantee — the backend's
   * cancel-and-replace logic is unconditional regardless of whether this check ran or raced, so a
   * failed/racy check here just falls through to submitting directly.
   */
  async function confirmImport() {
    if (!pendingFile) return;
    try {
      const activeTask = await checkActiveImportTask({ companyId, kind: 'WORKER_SYNC' }).unwrap();
      if (activeTask) {
        dispatch(dialogOpened({ kind: 'csvImportInProgressConfirm' }));
        return;
      }
    } catch {
      // The check itself failing shouldn't block the upload -- fall through to submitting.
    }
    await submitImport();
  }

  function cancelInProgressConfirm() {
    dispatch(dialogClosed());
    setPendingFile(null);
  }

  function closeResult() {
    dispatch(dialogClosed());
    setJobId(undefined);
  }

  // Narrowed by job `name`, not by structural shape: `ImportResult` (worker CSV) and
  // `AvailabilityImportResult` (Availability v2's month-scoped CSV, see `AvailabilityCsvPanel.tsx`)
  // now share the `totalRows` field, so a `'totalRows' in result` check alone no longer
  // distinguishes them — `AvailabilityImportResult` would satisfy it too and fail to narrow to
  // exactly `ImportResult`, since it's missing `inserted`/`updated`.
  const jobResult: ImportResult | null =
    jobPoll.data?.state === 'completed' && jobPoll.data.name === 'csv-import' && jobPoll.data.result
      ? (jobPoll.data.result as ImportResult)
      : null;

  return (
    <div className="card">
      <div className="card__title">Bulk import / export</div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-secondary)' }}>
        Import is a <strong>full workforce sync for this company</strong>: every row in the file is
        inserted or updated. A worker absent from the file stays Active but is not eligible for the
        next roster generation until they reappear in a completed sync.
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
                This file will become the authoritative worker list for this company. A worker
                whose national ID is not in this file <strong>stays Active</strong> but is not
                eligible for the next roster generation until they reappear in a completed sync. A
                row present in the file but failing validation is skipped, not applied.
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
                I understand this file becomes the authoritative worker list for this company.
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

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'csvImportInProgressConfirm'}
        title="Import already in progress"
        body={
          <p className="warn-text">
            <span aria-hidden="true">⚠</span>
            <span>
              An import is still processing for this company. Uploading now will cancel it and
              start over. Continue?
            </span>
          </p>
        }
        confirmLabel="Continue"
        destructive
        confirmDisabled={importResult.isLoading}
        onConfirm={() => void submitImport()}
        onCancel={cancelInProgressConfirm}
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
          </>
        )}
      </Modal>
    </div>
  );
}
