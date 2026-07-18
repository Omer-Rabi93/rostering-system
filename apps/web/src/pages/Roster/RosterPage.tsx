import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertChecklist,
  CalendarGrid,
  ConfirmDialog,
  EmptyState,
  JobProgress,
  Select,
  Spinner,
  Toast,
  ToastRegion,
  type AlertChecklistAlert,
  type SlotData,
} from '@rostering/ui';
import type { Alert, Month, Roster, Shift, ShiftType } from '@rostering/shared';

import {
  useAckAlertMutation,
  useAddShiftWorkerMutation,
  useGenerateRosterMutation,
  useGetRosterQuery,
  useMoveShiftWorkerMutation,
  usePublishRosterMutation,
  useRemoveShiftWorkerMutation,
} from '../../api/rosters.api.js';
import { useListCompaniesQuery } from '../../api/companies.api.js';
import { useListWorkersQuery } from '../../api/workers.api.js';
import { useJobPolling } from '../../api/jobs.api.js';
import { classifyMutationError, isPublishBlockedError } from '../../api/errors.js';
import { buildMonthDays, currentMonth } from '../../lib/calendar.js';
import { formatMonthLong } from '../../lib/format.js';
import { useToasts } from '../../hooks/useToasts.js';
import { ackRequested, ackSettled } from '../../store/ackChecklist.slice.js';
import { dialogClosed, dialogOpened, selectActiveDialog } from '../../store/dialogs.slice.js';
import { slotFocused, selectFocusedSlot, type PendingEdit } from '../../store/rosterEditor.slice.js';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { AvailabilityCsvPanel } from './AvailabilityCsvPanel.js';
import { AvailabilityGrid } from './AvailabilityGrid.js';
import type { SlotActionOutcome } from './SlotEditDialog.js';
import { SlotEditDialog } from './SlotEditDialog.js';

const SHIFT_ROWS = ['A', 'B', 'C'] as const;
type RosterView = 'roster' | 'availability';

function findShift(roster: Roster | undefined, date: string, shift: ShiftType): Shift | undefined {
  return roster?.shifts.find((s) => s.date === date && s.shiftType === shift);
}

function formatAlertDetail(alert: Alert, workerName: (id: number) => string): string {
  if (alert.type === 'UNFILLABLE_SLOT') {
    return `${alert.detail.date} · Shift ${alert.detail.shift} · ${alert.detail.role} — understaffed`;
  }
  return `${workerName(alert.detail.workerId)} — ${alert.detail.deficitHours}h short of contracted minimum`;
}

export function RosterPage(): ReactElement {
  const params = useParams<{ month: string }>();
  const navigate = useNavigate();
  const month: Month = params.month ?? currentMonth();

  // Company-scoped rostering: each company has its own independent worker pool, staffing
  // requirements, and roster -- this page needs a selected company before it can fetch/generate
  // anything roster-shaped. Defaults to the first company returned by `GET /api/companies` (no
  // dedicated "current company" concept elsewhere in the app yet), overridable via the selector
  // below.
  const { data: companies, isLoading: companiesLoading } = useListCompaniesQuery();
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | undefined>(undefined);
  const companyId = selectedCompanyId ?? companies?.[0]?.id;

  const { data: roster, isLoading } = useGetRosterQuery(
    { companyId: companyId ?? -1, month },
    { skip: companyId === undefined },
  );
  // Scoped to the same company as the roster -- a company's roster can only ever be staffed from
  // that company's own workforce, so the "add a worker" pickers never offer another company's
  // workers.
  const { data: workers } = useListWorkersQuery(companyId !== undefined ? { companyId } : undefined);
  const workerName = useMemo(() => {
    const map = new Map((workers ?? []).map((w) => [w.id, w.name]));
    return (id: number) => map.get(id) ?? `Worker #${id}`;
  }, [workers]);

  const [generateRoster] = useGenerateRosterMutation();
  const [ackAlert] = useAckAlertMutation();
  const [publishRoster] = usePublishRosterMutation();
  const [addShiftWorker] = useAddShiftWorkerMutation();
  const [moveShiftWorker] = useMoveShiftWorkerMutation();
  const [removeShiftWorker] = useRemoveShiftWorkerMutation();

  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const jobPoll = useJobPolling(jobId);

  const activeDialog = useAppSelector(selectActiveDialog);
  const focusedSlot = useAppSelector(selectFocusedSlot);
  const dispatch = useAppDispatch();
  const { toasts, pushToast, dismissToast } = useToasts();
  const [view, setView] = useState<RosterView>('roster');

  async function startGenerate(force: boolean) {
    if (companyId === undefined) return;
    try {
      const { jobId: newJobId } = await generateRoster({ companyId, month, force }).unwrap();
      setJobId(newJobId);
    } catch (err) {
      const classified = classifyMutationError(err);
      if (classified.kind === 'conflictMessage' && classified.body.reason === 'generation-in-progress') {
        // A second "regenerate as draft" click here would just collide with the in-flight job's
        // singletonKey and 409 again — there's nothing new to confirm, so surface that a
        // generation job is already running instead of re-offering the same dialog. The API
        // doesn't return the in-flight job's id on this 409, so we can only resume this tab's own
        // `JobProgress` (if this tab is the one that started it) rather than adopt a stranger job.
        pushToast('warning', `A roster generation for ${formatMonthLong(month)} is already running — please wait for it to finish.`);
      } else if (classified.kind === 'conflictMessage') {
        dispatch(dialogOpened({ kind: 'regeneratePublishedConfirm', month }));
      } else {
        pushToast('error', 'Could not start roster generation. Please try again.');
      }
    }
  }

  function handleGenerateClick() {
    if (roster?.status === 'PUBLISHED') {
      dispatch(dialogOpened({ kind: 'regeneratePublishedConfirm', month }));
    } else {
      void startGenerate(false);
    }
  }

  async function confirmRegenerate() {
    dispatch(dialogClosed());
    await startGenerate(true);
  }

  function handleSlotActivate(date: string, shift: ShiftType) {
    dispatch(slotFocused({ date, shift }));
    dispatch(dialogOpened({ kind: 'rosterEditDialog', shiftId: findShift(roster, date, shift)?.id ?? -1 }));
  }

  function getSlot(date: string, shift: ShiftType): SlotData {
    const shiftRow = findShift(roster, date, shift);
    const hasUnfillableAlert = (roster?.alerts ?? []).some(
      (a) => a.type === 'UNFILLABLE_SLOT' && a.detail.date === date && a.detail.shift === shift,
    );
    return {
      workers: (shiftRow?.assignments ?? []).map((a) => ({ id: a.workerId, name: a.name, role: a.role })),
      ...(hasUnfillableAlert ? { alertSeverity: 'warning' as const } : {}),
    };
  }

  /**
   * Single entry point for all three manual-edit kinds (add / move / remove) — `SlotEditDialog`
   * builds a `PendingEdit` describing whichever one the planner triggered and hands it here, so
   * the 422-block / 409-confirm classification (shared by all three server endpoints, since they
   * all run through the same `RosterValidator`) is written once instead of forked per-kind.
   */
  async function handleSubmitEdit(edit: PendingEdit): Promise<SlotActionOutcome> {
    if (companyId === undefined) {
      return { ok: false, kind: 'blocked', violations: ['No company selected.'] };
    }
    try {
      if (edit.kind === 'add') {
        await addShiftWorker({ shiftId: edit.shiftId, workerId: edit.workerId, companyId, month }).unwrap();
      } else if (edit.kind === 'remove') {
        await removeShiftWorker({ shiftId: edit.shiftId, workerId: edit.workerId, companyId, month }).unwrap();
      } else {
        if (edit.targetShiftId === undefined) {
          return { ok: false, kind: 'blocked', violations: ['No target slot selected.'] };
        }
        await moveShiftWorker({
          shiftId: edit.shiftId,
          workerId: edit.workerId,
          targetShiftId: edit.targetShiftId,
          companyId,
          month,
        }).unwrap();
      }
      return { ok: true };
    } catch (err) {
      const classified = classifyMutationError(err);
      if (classified.kind === 'unprocessable') {
        return {
          ok: false,
          kind: 'blocked',
          violations: classified.body.violations.map((v) =>
            typeof v.detail === 'object' && v.detail && 'message' in v.detail ? String(v.detail.message) : v.code,
          ),
        };
      }
      if (classified.kind === 'confirmRequired') {
        return {
          ok: false,
          kind: 'confirm',
          warnings: classified.body.warnings.map((w) =>
            typeof w.detail === 'object' && w.detail && 'message' in w.detail ? String(w.detail.message) : w.code,
          ),
        };
      }
      return { ok: false, kind: 'blocked', violations: ['Could not save this change. Please try again.'] };
    }
  }

  async function handleConfirmEdit(edit: PendingEdit): Promise<void> {
    if (companyId === undefined) return;
    if (edit.kind === 'add') {
      await addShiftWorker({ shiftId: edit.shiftId, workerId: edit.workerId, companyId, month, confirm: true }).unwrap();
    } else if (edit.kind === 'remove') {
      await removeShiftWorker({ shiftId: edit.shiftId, workerId: edit.workerId, companyId, month, confirm: true }).unwrap();
    } else if (edit.targetShiftId !== undefined) {
      await moveShiftWorker({
        shiftId: edit.shiftId,
        workerId: edit.workerId,
        targetShiftId: edit.targetShiftId,
        companyId,
        month,
        confirm: true,
      }).unwrap();
    }
  }

  async function handleAcknowledge(alertId: number) {
    if (!roster || companyId === undefined) return;
    dispatch(ackRequested(alertId));
    try {
      await ackAlert({ rosterId: roster.id, alertId, companyId, month }).unwrap();
    } catch {
      pushToast('error', 'Could not acknowledge this alert. Please try again.');
    } finally {
      dispatch(ackSettled(alertId));
    }
  }

  async function handlePublish() {
    if (!roster || companyId === undefined) return;
    try {
      await publishRoster({ rosterId: roster.id, companyId, month }).unwrap();
      pushToast('success', `${formatMonthLong(month)} published.`);
    } catch (err) {
      if (isPublishBlockedError(err as never)) {
        pushToast(
          'error',
          `Can't publish yet — ${(err as { data: { unacknowledgedAlertIds: number[] } }).data.unacknowledgedAlertIds.length} alert(s) still unacknowledged.`,
        );
      } else {
        pushToast('error', 'Could not publish this roster. Please try again.');
      }
    }
  }

  const days = useMemo(() => buildMonthDays(month), [month]);
  const alerts: AlertChecklistAlert[] = (roster?.alerts ?? []).map((a) => ({
    id: a.id,
    type: a.type === 'UNFILLABLE_SLOT' ? 'unfillable_slot' : 'min_hours_shortfall',
    detail: formatAlertDetail(a, workerName),
    acknowledged: a.acknowledged,
  }));
  const allAcked = alerts.every((a) => a.acknowledged);
  const focusedShiftRow = focusedSlot ? findShift(roster, focusedSlot.date, focusedSlot.shift) : undefined;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Roster — {formatMonthLong(month)}</h1>
          <p>
            Month-wide grid: one column per day, 3 rows per day (Shift A / B / C). Click or
            keyboard-activate a slot to add, move, or remove a worker.
          </p>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label visually-hidden" htmlFor="roster-company">
            Company
          </label>
          <Select
            id="roster-company"
            value={companyId !== undefined ? String(companyId) : ''}
            options={(companies ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            onChange={(e) => setSelectedCompanyId(Number(e.target.value))}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field__label visually-hidden" htmlFor="roster-month">
            Month
          </label>
          <input
            id="roster-month"
            className="field__input"
            type="month"
            value={month}
            onChange={(e) => {
              if (e.target.value) void navigate(`/roster/${e.target.value}`);
            }}
          />
        </div>
      </div>

      {companiesLoading ? (
        <Spinner label="Loading companies" />
      ) : companies && companies.length === 0 ? (
        <EmptyState
          icon={<span aria-hidden="true">🏢</span>}
          title="No companies yet"
          body="Rostering is per-company — add at least one company before generating a roster."
          action={{ label: 'Go to Companies', onClick: () => void navigate('/companies') }}
        />
      ) : (
        <>
          <div className="toolbar" role="tablist" aria-label="Roster page sections">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'roster'}
              className={`btn btn--sm ${view === 'roster' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setView('roster')}
            >
              Roster grid
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'availability'}
              className={`btn btn--sm ${view === 'availability' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setView('availability')}
            >
              Availability
            </button>
          </div>

          {view === 'availability' ? (
            <>
              <AvailabilityGrid month={month} />
              <AvailabilityCsvPanel month={month} />
            </>
          ) : isLoading ? null : !roster ? (
            <>
              <EmptyState
                icon={<span aria-hidden="true">📅</span>}
                title={`No roster for ${formatMonthLong(month)} yet`}
                body="Generate a draft from active workers, their contracts, and the current staffing requirements. You'll review alerts before publishing."
                action={{ label: 'Generate roster', onClick: () => void startGenerate(false) }}
              />
              {jobId ? (
                <JobProgress
                  state={jobPoll.data?.state ?? 'created'}
                  label={
                    jobPoll.data?.state === 'completed'
                      ? `Generated ${formatMonthLong(month)}.`
                      : jobPoll.data?.state === 'failed'
                        ? 'Generation failed.'
                        : `Generating roster for ${formatMonthLong(month)}…`
                  }
                  {...(jobPoll.data?.state === 'failed' ? { errorMessage: 'See server logs for details.' } : {})}
                />
              ) : null}
            </>
          ) : (
            <div className="split-layout">
              <div>
                <div className="calendar">
                  <div className="calendar__toolbar">
                    <button className="btn btn--secondary btn--sm" type="button" onClick={handleGenerateClick}>
                      {roster.status === 'PUBLISHED' ? 'Regenerate…' : 'Regenerate roster'}
                    </button>
                  </div>
                  {jobId && jobPoll.data?.state !== 'completed' ? (
                    <JobProgress
                      state={jobPoll.data?.state ?? 'created'}
                      label={jobPoll.data?.state === 'failed' ? 'Generation failed.' : `Generating roster for ${formatMonthLong(month)}…`}
                      {...(jobPoll.data?.state === 'failed' ? { errorMessage: 'See server logs for details.' } : {})}
                    />
                  ) : null}
                  <CalendarGrid
                    month={month}
                    days={days}
                    shiftRows={SHIFT_ROWS}
                    getSlot={getSlot}
                    onSlotActivate={handleSlotActivate}
                  />
                </div>
              </div>

              <aside className="side-panel" aria-label="Alerts">
                <div className="card">
                  <div className="card__title">Alerts ({alerts.length})</div>
                  <div
                    className={`gate-status ${allAcked ? 'gate-status--ready' : 'gate-status--blocked'}`}
                    role="status"
                    aria-live="polite"
                  >
                    {allAcked
                      ? '✓ All clear — ready to publish'
                      : `⚠ ${alerts.filter((a) => !a.acknowledged).length} unacknowledged — Publish disabled`}
                  </div>
                  <AlertChecklist alerts={alerts} onAcknowledge={(id) => void handleAcknowledge(id)} />
                  <button
                    className="btn btn--primary"
                    type="button"
                    style={{ width: '100%', marginTop: 'var(--space-4)' }}
                    disabled={!allAcked || roster.status === 'PUBLISHED'}
                    onClick={() => void handlePublish()}
                  >
                    Publish roster
                  </button>
                </div>
              </aside>
            </div>
          )}
        </>
      )}

      {roster && focusedSlot && companyId !== undefined ? (
        <SlotEditDialog
          isOpen={activeDialog?.kind === 'rosterEditDialog'}
          date={focusedSlot.date}
          shift={focusedSlot.shift}
          shiftRow={focusedShiftRow}
          roster={roster}
          companyId={companyId}
          onClose={() => dispatch(dialogClosed())}
          onSubmitEdit={handleSubmitEdit}
          onConfirmEdit={handleConfirmEdit}
        />
      ) : null}

      <ConfirmDialog
        isOpen={activeDialog?.kind === 'regeneratePublishedConfirm'}
        title={`Regenerate ${formatMonthLong(month)}?`}
        body={
          <p className="warn-text">
            <span aria-hidden="true">⚠</span>
            <span>
              This month is currently Published. Regenerating reopens it as a Draft, replaces every
              assignment, and re-runs the alert/acknowledgment gate — publish again once you&apos;ve
              reviewed the new alerts.
            </span>
          </p>
        }
        confirmLabel="Regenerate as draft"
        destructive
        onConfirm={() => void confirmRegenerate()}
        onCancel={() => dispatch(dialogClosed())}
      />

      <ToastRegion>
        {toasts.map((toast) => (
          <Toast key={toast.id} variant={toast.variant} message={toast.message} onDismiss={() => dismissToast(toast.id)} />
        ))}
      </ToastRegion>
    </div>
  );
}
