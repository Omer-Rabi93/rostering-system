import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ConfirmDialog, JobProgress, Modal, Table, type Column } from '@rostering/ui';
import type { AvailabilityImportResult, Month } from '@rostering/shared';

import { exportAvailabilityCsvUrl, useImportAvailabilityCsvMutation } from '../../api/availability.api.js';
import { baseApi } from '../../api/baseApi.js';
import { classifyMutationError } from '../../api/errors.js';
import { useLazyGetActiveImportTaskQuery } from '../../api/importTasks.api.js';
import { useJobPolling } from '../../api/jobs.api.js';
import { useActiveCompanyId } from '../../hooks/useActiveCompanyId.js';
import { dialogClosed, dialogOpened, selectActiveDialog } from '../../store/dialogs.slice.js';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';

export interface AvailabilityCsvPanelProps {
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
 * The availability CSV import/export panel for one month — same `ConfirmDialog`-gated shape as
 * the worker `CsvPanel`, but deliberately WITHOUT any deactivation-sweep messaging: an
 * availability-CSV import is a per-row apply (national_id + that month's `dNN` columns), not a
 * full-workforce sync — a worker absent from the file simply keeps whatever rows they already
 * have (see `apps/api/src/routes/availability.ts`'s `availability-import` job). The confirm
 * dialog instead states the real semantics: this REPLACES every row this file specifies for the
 * month (any date/worker combination present in the file overwrites what's there; anything absent
 * from the file is left untouched).
 *
 * Job-completion invalidation is month-scoped here (unlike `jobs.api.ts`'s generic
 * `csv-import` -> `Worker` handling), because the `Job` schema carries no month field for
 * `jobs.api.ts`'s shared `onQueryStarted` to key off of — so this component, which already knows
 * both the jobId and the month it started the import for, invalidates `{ type: 'Availability', id:
 * month }` itself once the job reaches `completed`.
 *
 * v4: the upload is scoped to the active company (`useActiveCompanyId()`), and a pre-upload check
 * against `GET /api/import-tasks/active` gates the actual submit behind a second confirm dialog
 * when an `AVAILABILITY_SYNC` import is already in flight for this company (see the v4 design
 * doc, Part A's Frontend section, and `CsvPanel.tsx`'s identical treatment for the worker CSV).
 */
export function AvailabilityCsvPanel({ month }: AvailabilityCsvPanelProps): ReactElement {
  const companyId = useActiveCompanyId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [importError, setImportError] = useState<string | null>(null);

  const [importCsv, importResult] = useImportAvailabilityCsvMutation();
  const [checkActiveImportTask] = useLazyGetActiveImportTaskQuery();
  const jobPoll = useJobPolling(jobId);

  const activeDialog = useAppSelector(selectActiveDialog);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (jobPoll.data?.state === 'completed' && jobPoll.data.name === 'availability-import') {
      dispatch(baseApi.util.invalidateTags([{ type: 'Availability', id: month }]));
    }
  }, [jobPoll.data, dispatch, month]);

  function handleFileChosen() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setConfirmChecked(false);
    setImportError(null);
    dispatch(dialogOpened({ kind: 'availabilityCsvImportConfirm' }));
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
      dispatch(dialogOpened({ kind: 'availabilityCsvImportResult', jobId: newJobId }));
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
   * v4 pre-upload check (mirrors `CsvPanel.tsx`'s identical treatment for the worker CSV): before
   * actually submitting, check whether an `AVAILABILITY_SYNC` import is already in flight for this
   * company. If so, gate the upload behind a second confirm dialog. A failed/racy check falls
   * through to submitting directly — this is a UX nicety, not the correctness guarantee.
   */
  async function confirmImport() {
    if (!pendingFile) return;
    try {
      const activeTask = await checkActiveImportTask({ companyId, kind: 'AVAILABILITY_SYNC' }).unwrap();
      if (activeTask) {
        dispatch(dialogOpened({ kind: 'availabilityCsvImportInProgressConfirm' }));
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

  const jobResult: AvailabilityImportResult | null =
    jobPoll.data?.state === 'completed' && jobPoll.data.name === 'availability-import' && jobPoll.data.result
      ? (jobPoll.data.result as AvailabilityImportResult)
      : null;

  return (
    <div className="card">
      <div className="card__title">Availability CSV import / export — {month}</div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-secondary)' }}>
        Import applies only the rows in this file: each national_id + date cell REPLACES that
        exact date&apos;s availability. Workers or dates absent from the file are left unchanged —
        this is not a full-workforce sync (no deactivation sweep, unlike the worker CSV import).
      </p>
      {importError ? (
        <p className="warn-text" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{importError}</span>
        </p>
      ) : null}
      <div className="toolbar">
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label" htmlFor="availability-csv-file">
            CSV file
          </label>
          <input
            id="availability-csv-file"
            className="field__input"
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleFileChosen}
          />
        </div>
        <span className="spacer" />
        <a className="btn btn--secondary" href={exportAvailabilityCsvUrl(month)}>
          Export {month} availability (.csv)
        </a>
      </div>

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'availabilityCsvImportConfirm'}
        title={`Confirm import — ${month} availability`}
        body={
          <>
            <p className="warn-text">
              <span aria-hidden="true">⚠</span>
              <span>
                Every (national_id, date) cell in this file <strong>replaces</strong> that exact
                date&apos;s availability for that worker. Workers or dates not mentioned in the
                file are left exactly as they are — nothing is deactivated by this import.
              </span>
            </p>
            <div className="field-checkbox">
              <input
                type="checkbox"
                id="availability-csv-confirm-check"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              <label htmlFor="availability-csv-confirm-check">
                I understand this replaces availability for every row in this file.
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
        isOpen={activeDialog?.kind === 'availabilityCsvImportInProgressConfirm'}
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
        isOpen={activeDialog?.kind === 'availabilityCsvImportResult'}
        onClose={closeResult}
        titleId="availability-csv-result-title"
        title={jobResult ? 'Import complete' : `Importing ${month} availability`}
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
                : `Importing ${pendingFile?.name ?? 'availability.csv'}…`
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
                <div className="stat-tile__label">Applied</div>
                <div className="stat-tile__value">{jobResult.applied}</div>
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
