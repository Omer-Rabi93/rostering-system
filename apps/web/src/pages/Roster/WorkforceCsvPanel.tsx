import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ConfirmDialog, JobProgress, Modal, Table, type Column } from '@rostering/ui';
import { importResultSchema, type ImportResult, type Month } from '@rostering/shared';

import { availabilityTag } from '../../api/availability.api.js';
import { baseApi } from '../../api/baseApi.js';
import { classifyMutationError } from '../../api/errors.js';
import { useLazyGetActiveImportTaskQuery } from '../../api/importTasks.api.js';
import { useJobPolling } from '../../api/jobs.api.js';
import { exportWorkforceCsvUrl, useImportWorkforceCsvMutation } from '../../api/workforceCsv.api.js';
import { useActiveCompanyId } from '../../hooks/useActiveCompanyId.js';
import { dialogClosed, dialogOpened, selectActiveDialog } from '../../store/dialogs.slice.js';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';

export interface WorkforceCsvPanelProps {
  readonly month: Month;
}

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

/**
 * The combined workforce CSV import/export panel for one month — supersedes the Workers page's
 * `CsvPanel` (worker-only) and the Roster page's `AvailabilityCsvPanel` (availability-only); see
 * the Part G design doc. Lives on the Roster page rather than Workers: the combined CSV's header
 * depends on the target month's day count, so it's inherently month-scoped, and the Roster page
 * already carries that context via its own route.
 *
 * Combines both prior panels' semantics in one confirm dialog: (1) worker fields ARE a full sync —
 * a worker whose national ID is absent from the file stays Active but is not eligible for the next
 * roster generation until they reappear in a completed sync; (2) availability for the target month
 * is fully replaced per worker — every (national_id, date) cell in the file replaces that exact
 * date's availability, dates/workers not mentioned are left untouched; (3) NEW row atomicity — a
 * bad cell anywhere in a row (a worker field OR a `dNN` cell) fails that whole row, including the
 * worker upsert, not just the availability half (see `WorkforceImportService.importRow`).
 *
 * Job-completion invalidation: `jobs.api.ts`'s generic `workforce-import` -> `Worker` handling
 * covers the worker-registry side. The availability-grid side is month-scoped and the `Job` schema
 * carries no month field for that generic handler to key off of — so this component, which already
 * knows both the jobId and the month/company it started the import for, invalidates this
 * `(companyId, month)`'s `Availability` tag itself once the job reaches `completed`.
 */
export function WorkforceCsvPanel({ month }: WorkforceCsvPanelProps): ReactElement {
  const companyId = useActiveCompanyId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [importError, setImportError] = useState<string | null>(null);

  const [importCsv, importResult] = useImportWorkforceCsvMutation();
  const [checkActiveImportTask] = useLazyGetActiveImportTaskQuery();
  const jobPoll = useJobPolling(jobId);

  const activeDialog = useAppSelector(selectActiveDialog);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (jobPoll.data?.state === 'completed' && jobPoll.data.name === 'workforce-import') {
      dispatch(baseApi.util.invalidateTags([availabilityTag({ companyId, month })]));
    }
  }, [jobPoll.data, dispatch, companyId, month]);

  function handleFileChosen() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setConfirmChecked(false);
    setImportError(null);
    dispatch(dialogOpened({ kind: 'workforceCsvImportConfirm' }));
  }

  function cancelConfirm() {
    dispatch(dialogClosed());
    setPendingFile(null);
  }

  async function submitImport() {
    if (!pendingFile) return;
    try {
      const { jobId: newJobId } = await importCsv({ month, companyId, file: pendingFile }).unwrap();
      setImportError(null);
      setJobId(newJobId);
      dispatch(dialogOpened({ kind: 'workforceCsvImportResult', jobId: newJobId }));
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
   * v4 pre-upload check: before actually submitting, check whether a workforce-CSV import is
   * already in flight for this company. If so, gate the upload behind a second confirm dialog
   * rather than silently cancelling/replacing it out from under whoever started it. This is a UX
   * nicety, not the correctness guarantee — the backend's cancel-and-replace logic is
   * unconditional regardless of whether this check ran or raced, so a failed/racy check here just
   * falls through to submitting directly.
   */
  async function confirmImport() {
    if (!pendingFile) return;
    try {
      const activeTask = await checkActiveImportTask({ companyId, kind: 'WORKFORCE_SYNC' }).unwrap();
      if (activeTask) {
        dispatch(dialogOpened({ kind: 'workforceCsvImportInProgressConfirm' }));
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

  // Parsed, not asserted: the job's `result` payload crosses the wire untyped, so claim its shape
  // through the same shared schema the API's own job handler serializes against. A mismatched
  // payload renders as "no result" instead of a runtime surprise deeper in the report table.
  const parsedResult =
    jobPoll.data?.state === 'completed' && jobPoll.data.name === 'workforce-import'
      ? importResultSchema.safeParse(jobPoll.data.result)
      : null;
  const jobResult: ImportResult | null = parsedResult?.success ? parsedResult.data : null;

  return (
    <div className="card">
      <div className="card__title">Workforce CSV import / export — {month}</div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-secondary)' }}>
        Import is a <strong>full workforce sync for this company</strong> plus a full replace of
        each worker&apos;s {month} availability. A worker absent from the file stays Active but is
        not eligible for the next roster generation until they reappear in a completed sync. A row
        with any invalid cell — a worker field or a day column — is skipped entirely, including
        that row&apos;s availability.
      </p>
      {importError ? (
        <p className="warn-text" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{importError}</span>
        </p>
      ) : null}
      <div className="toolbar">
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label" htmlFor="workforce-csv-file">
            CSV file
          </label>
          <input
            id="workforce-csv-file"
            className="field__input"
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleFileChosen}
          />
        </div>
        <span className="spacer" />
        <a className="btn btn--secondary" href={exportWorkforceCsvUrl(month, companyId)}>
          Export {month} workforce (.csv)
        </a>
      </div>

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'workforceCsvImportConfirm'}
        title="Confirm import — full workforce sync"
        body={
          <>
            <p className="warn-text">
              <span aria-hidden="true">⚠</span>
              <span>
                This file will become the authoritative worker list for this company, and every
                (national_id, date) cell in it <strong>replaces</strong> that worker&apos;s {month}{' '}
                availability. A worker whose national ID is not in this file <strong>stays Active</strong>{' '}
                but is not eligible for the next roster generation until they reappear in a
                completed sync. A row with any invalid cell (worker field or day column) is
                skipped entirely, not partially applied.
              </span>
            </p>
            <div className="field-checkbox">
              <input
                type="checkbox"
                id="workforce-csv-confirm-check"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              <label htmlFor="workforce-csv-confirm-check">
                I understand this file becomes the authoritative worker list and replaces {month}{' '}
                availability for every row in it.
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
        isOpen={activeDialog?.kind === 'workforceCsvImportInProgressConfirm'}
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
        isOpen={activeDialog?.kind === 'workforceCsvImportResult'}
        onClose={closeResult}
        titleId="workforce-csv-result-title"
        title={jobResult ? 'Import complete' : `Importing ${month} workforce`}
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
                : `Importing ${pendingFile?.name ?? 'workforce.csv'}…`
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
