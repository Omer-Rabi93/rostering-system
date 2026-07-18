import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Badge, Modal, ROLE_CLASS } from '@rostering/ui';
import { SHIFT_TYPES } from '@rostering/shared';
import type { Role, Roster, Shift, ShiftType } from '@rostering/shared';

import type { WorkerDto } from '../../api/workers.api.js';
import { useListWorkersQuery } from '../../api/workers.api.js';
import { useGetMonthAvailabilityQuery } from '../../api/availability.api.js';
import { useListStaffingRequirementsQuery } from '../../api/staffingRequirements.api.js';
import { editCleared, editStaged, selectPendingEdit, type PendingEdit, type PendingEditKind } from '../../store/rosterEditor.slice.js';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { getIneligibilityReason } from './eligibility.js';
import { initialEditFlowState, reduceEditFlow } from './editFlow.js';
import { buildRoleGroups } from './roleGroups.js';

export type SlotActionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'blocked'; readonly violations: string[] }
  | { readonly ok: false; readonly kind: 'confirm'; readonly warnings: string[] };

export interface SlotEditDialogProps {
  readonly isOpen: boolean;
  readonly date: string;
  readonly shift: ShiftType;
  readonly shiftRow: Shift | undefined;
  readonly roster: Roster;
  readonly onClose: () => void;
  /** Submits a staged add/move/remove edit; resolves `{ok:true}` on success, or a 422 `blocked` /
   * 409 `confirm` outcome the dialog renders as its own sub-state. Never throws — every rejection
   * the underlying mutation can produce is already classified into one of the two failure kinds. */
  readonly onSubmitEdit: (edit: PendingEdit) => Promise<SlotActionOutcome>;
  /** Resubmits an edit that previously came back `confirm`, with the server-side `?confirm=true`
   * override applied. */
  readonly onConfirmEdit: (edit: PendingEdit) => Promise<void>;
}

const SHIFT_LABEL: Record<ShiftType, string> = { A: '00:00–08:00', B: '08:00–16:00', C: '16:00–24:00' };

const ROLE_LABEL: Record<Role, string> = {
  GENERAL_GUARD: 'General Guard',
  SUPERVISOR: 'Supervisor',
  SCREENER: 'Screener',
};

const EMPTY_SELECTION: Record<Role, number | null> = {
  GENERAL_GUARD: null,
  SUPERVISOR: null,
  SCREENER: null,
};

const ACTION_LABEL: Record<
  PendingEditKind,
  { blockedTitle: string; confirmTitle: string; confirmLabel: string; actionVerb: string }
> = {
  add: {
    blockedTitle: "Can't make this assignment",
    confirmTitle: 'Confirm this assignment',
    confirmLabel: 'Save anyway',
    actionVerb: 'save this assignment',
  },
  remove: {
    blockedTitle: "Can't remove this worker",
    confirmTitle: 'Confirm this removal',
    confirmLabel: 'Remove anyway',
    actionVerb: 'remove this worker',
  },
  move: {
    blockedTitle: "Can't move this worker",
    confirmTitle: 'Confirm this move',
    confirmLabel: 'Move anyway',
    actionVerb: 'move this worker',
  },
};

interface MoveTarget {
  readonly workerId: number;
  readonly date: string;
  readonly shift: ShiftType;
}

/**
 * The roster manual-edit dialog: shows the slot's current assignments (with Remove and Move-to…)
 * and an "Add a worker" picker that greys out ineligible workers as an advisory hint
 * (`getIneligibilityReason`), driven by `editFlow`'s pure state machine (via `useReducer`) for the
 * 422-block / 409-confirm branching — shared by all three edit kinds (add/move/remove) via the
 * `rosterEditor` slice's `PendingEdit` (which record is currently in flight, so the confirm/blocked
 * sub-state knows what to resubmit and how to label itself).
 *
 * The idle body is split into three role sections (General Guard / Supervisor / Screener, via
 * `roleGroups.ts`), each with its own assigned-worker list and its own "Add a {role}" picker
 * filtered to `worker.role === thisRole`. There is no backend concept of a per-slot "required
 * role" — every assignment's role is always derived from `worker.role` server-side
 * (`shiftWorkerService.ts`) — so restricting each section's picker to workers of that one role is
 * what makes a role mismatch structurally unselectable in the first place; no separate validation
 * needed here or on the server for that.
 *
 * Deliberately a SINGLE `Modal` instance whose title/body/footer swap based on `flow.status`,
 * rather than three separately-mounted `Modal`/`ConfirmDialog`s layered on top of each other:
 * with three independent focus traps, each capturing/restoring focus off its own open/close
 * transitions, the 422/409 sub-states raced against the outer dialog's own focus-trap effects
 * (verified empirically — the eventual restored-focus target became non-deterministic). One
 * `Modal` means exactly one focus-trap lifecycle for the whole interaction: it captures the
 * originating `CalendarGrid` cell once, on open, and restores focus to it once, when the whole
 * interaction concludes (`onClose`) — regardless of how many 422/409 round-trips happened first.
 */
export function SlotEditDialog(props: SlotEditDialogProps): ReactElement {
  const { isOpen, date, shift, shiftRow, roster, onClose, onSubmitEdit, onConfirmEdit } = props;
  const { data: workers } = useListWorkersQuery({ status: 'ACTIVE' });
  // The same date-specific availability cache `AvailabilityGrid` reads for this roster's month —
  // eligibility hints below are keyed off the edit's exact `date`, not a weekday.
  const { data: monthAvailability } = useGetMonthAvailabilityQuery(roster.month);
  // The "Y required" half of each role section's "assigned X of Y required" count — the
  // role×shift staffing matrix, decoupled from any individual assignment (see this file's
  // module-level context: role-correctness is enforced by each section's picker being filtered to
  // that role, not by any per-slot "required role" concept server-side).
  const { data: staffingRequirements } = useListStaffingRequirementsQuery();

  // One independent selection per role section (General Guard / Supervisor / Screener), rather
  // than a single shared `selectedWorkerId`, now that the picker below is split into three —
  // picking a worker in one section's dropdown must not disturb another section's.
  const [selectedWorkerByRole, setSelectedWorkerByRole] = useState<Record<Role, number | null>>(EMPTY_SELECTION);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [flow, dispatchFlow] = useReducer(reduceEditFlow, initialEditFlowState);
  const pendingEdit = useAppSelector(selectPendingEdit);
  const dispatch = useAppDispatch();
  const titleId = 'slot-edit-title';

  useEffect(() => {
    if (isOpen) {
      dispatchFlow({ type: 'reset' });
      setSelectedWorkerByRole(EMPTY_SELECTION);
      setMoveTarget(null);
      dispatch(editCleared());
    }
  }, [isOpen, date, shift, dispatch]);

  // `Modal`'s own focus-trap (`useFocusTrap`) only moves focus in when `isOpen` itself flips — by
  // design, so the 422-block/409-confirm round trip stays a single focus-trap lifecycle instead of
  // racing three (see this component's own doc comment above). But that means when `flow.status`
  // changes *while the dialog stays open* (submitting an add swaps the body/footer to the
  // blocked/confirming state), whatever was focused a moment ago (e.g. one role section's "Add"
  // button) has just been unmounted, and focus silently falls back to `<body>` — outside the
  // dialog, where the trap no longer intercepts Tab at all. Explicitly re-focusing this sub-state's
  // own primary button whenever `flow.status` changes keeps focus inside the dialog through every
  // transition, not just the very first one.
  const blockedOkButtonRef = useRef<HTMLButtonElement>(null);
  const confirmPrimaryButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (flow.status === 'blocked') {
      blockedOkButtonRef.current?.focus();
    } else if (flow.status === 'confirming') {
      confirmPrimaryButtonRef.current?.focus();
    }
  }, [flow.status]);

  const eligibleWorkers = (workers ?? []).map((worker: WorkerDto) => ({
    worker,
    reason: getIneligibilityReason(worker, worker.contract, monthAvailability, roster, date, shift),
  }));

  // Always all 3 roles, in General Guard / Supervisor / Screener order, each paired with its
  // "assigned X of Y required" count for this exact shift type — see `roleGroups.ts`.
  const roleGroups = useMemo(
    () => buildRoleGroups(shiftRow?.assignments ?? [], staffingRequirements ?? [], shift),
    [shiftRow, staffingRequirements, shift],
  );

  // Every day in the roster's month has a Shift row for all three shift types (created up-front
  // at generation time — see `rosterGenerationService.persistDraft`), even if unassigned, so the
  // Move date picker can be bounded to the roster's own month without a separate lookup.
  const monthDates = useMemo(() => Array.from(new Set(roster.shifts.map((s) => s.date))).sort(), [roster.shifts]);
  const minDate = monthDates[0];
  const maxDate = monthDates[monthDates.length - 1];

  function targetShiftIdFor(targetDate: string, targetShift: ShiftType): number | undefined {
    return roster.shifts.find((s) => s.date === targetDate && s.shiftType === targetShift)?.id;
  }

  async function runEdit(edit: PendingEdit) {
    dispatch(editStaged(edit));
    dispatchFlow({ type: 'submit' });
    const result = await onSubmitEdit(edit);
    if (result.ok) {
      dispatchFlow({ type: 'succeeded' });
      dispatch(editCleared());
      setMoveTarget(null);
      onClose();
      return;
    }
    if (result.kind === 'blocked') {
      dispatchFlow({ type: 'hardBlocked', violations: result.violations });
    } else {
      dispatchFlow({ type: 'confirmRequired', warnings: result.warnings });
    }
  }

  async function handleAdd(role: Role) {
    const workerId = selectedWorkerByRole[role];
    if (workerId === null || !shiftRow) return;
    await runEdit({ kind: 'add', shiftId: shiftRow.id, workerId });
  }

  async function handleRemove(workerId: number) {
    if (!shiftRow) return;
    await runEdit({ kind: 'remove', shiftId: shiftRow.id, workerId });
  }

  async function handleMove(workerId: number, targetDate: string, targetShift: ShiftType) {
    if (!shiftRow) return;
    if (targetDate === date && targetShift === shift) {
      dispatchFlow({ type: 'hardBlocked', violations: ['Pick a different day or shift to move to.'] });
      return;
    }
    const targetShiftId = targetShiftIdFor(targetDate, targetShift);
    if (targetShiftId === undefined) {
      dispatchFlow({ type: 'hardBlocked', violations: ["That date is outside this roster's month."] });
      return;
    }
    await runEdit({ kind: 'move', shiftId: shiftRow.id, workerId, targetShiftId });
  }

  async function handleConfirmAnyway() {
    if (!pendingEdit) return;
    dispatchFlow({ type: 'confirmAccepted' });
    await onConfirmEdit(pendingEdit);
    dispatchFlow({ type: 'succeeded' });
    dispatch(editCleared());
    setMoveTarget(null);
    onClose();
  }

  function cancelPending() {
    dispatchFlow({ type: 'cancelled' });
    dispatch(editCleared());
  }

  let title: string;
  let body: ReactElement;
  let footer: ReactElement;

  if (flow.status === 'blocked') {
    const labels = ACTION_LABEL[pendingEdit?.kind ?? 'add'];
    title = labels.blockedTitle;
    body = (
      <p className="warn-text">
        <span aria-hidden="true">🚫</span>
        <span>
          <strong>Blocked (422)</strong> — {flow.violations.join(' ')} This rule has no override.
        </span>
      </p>
    );
    footer = (
      <button
        ref={blockedOkButtonRef}
        type="button"
        className="btn btn--primary"
        onClick={() => {
          dispatch(editCleared());
          onClose();
        }}
      >
        OK
      </button>
    );
  } else if (flow.status === 'confirming') {
    const labels = ACTION_LABEL[pendingEdit?.kind ?? 'add'];
    title = labels.confirmTitle;
    body = (
      <p className="warn-text">
        <span aria-hidden="true">⚠</span>
        <span>
          {flow.warnings.join(' ')} You can still {labels.actionVerb} — the alert will be recorded
          and must be acknowledged before publishing.
        </span>
      </p>
    );
    footer = (
      <>
        <button type="button" className="btn btn--secondary" onClick={cancelPending}>
          Cancel
        </button>
        <button ref={confirmPrimaryButtonRef} type="button" className="btn btn--primary" onClick={() => void handleConfirmAnyway()}>
          {labels.confirmLabel}
        </button>
      </>
    );
  } else {
    title = `${date} — Shift ${shift} (${SHIFT_LABEL[shift]})`;
    body = (
      <>
        {roleGroups.map((group) => {
          const roleClass = ROLE_CLASS[group.role];
          const headingId = `role-group-heading-${roleClass}`;
          const pickerId = `slot-add-worker-${roleClass}`;
          const eligibleForRole = eligibleWorkers.filter(({ worker }) => worker.role === group.role);
          const selectedWorkerId = selectedWorkerByRole[group.role];

          return (
            <section
              key={group.role}
              aria-labelledby={headingId}
              data-testid={`role-group-${roleClass}`}
              style={{ marginBottom: 'var(--space-4)' }}
            >
              <h3
                id={headingId}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}
              >
                <Badge kind="role" value={group.role} />
                <span>
                  Assigned {group.assignedCount} of {group.requiredCount} required
                </span>
              </h3>

              {group.assignedWorkers.length > 0 ? (
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 var(--space-3)' }}>
                  {group.assignedWorkers.map((assignment) => (
                    <li
                      key={assignment.workerId}
                      style={{
                        padding: 'var(--space-2) 0',
                        borderBottom: '1px solid var(--color-border)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>{assignment.name}</span>
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() =>
                              setMoveTarget(
                                moveTarget?.workerId === assignment.workerId
                                  ? null
                                  : { workerId: assignment.workerId, date, shift },
                              )
                            }
                          >
                            Move to…
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={flow.status === 'submitting'}
                            onClick={() => void handleRemove(assignment.workerId)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {moveTarget?.workerId === assignment.workerId ? (
                        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end', marginTop: 'var(--space-2)' }}>
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label className="field__label" htmlFor={`move-date-${assignment.workerId}`}>
                              Target date
                            </label>
                            <input
                              id={`move-date-${assignment.workerId}`}
                              className="field__input"
                              type="date"
                              min={minDate}
                              max={maxDate}
                              value={moveTarget.date}
                              onChange={(e) => setMoveTarget({ ...moveTarget, date: e.target.value })}
                            />
                          </div>
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label className="field__label" htmlFor={`move-shift-${assignment.workerId}`}>
                              Target shift
                            </label>
                            <select
                              id={`move-shift-${assignment.workerId}`}
                              className="field__input"
                              value={moveTarget.shift}
                              onChange={(e) => setMoveTarget({ ...moveTarget, shift: e.target.value as ShiftType })}
                            >
                              {SHIFT_TYPES.map((s) => (
                                <option key={s} value={s}>
                                  {s} — {SHIFT_LABEL[s]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            disabled={flow.status === 'submitting'}
                            onClick={() => void handleMove(assignment.workerId, moveTarget.date, moveTarget.shift)}
                          >
                            Move
                          </button>
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMoveTarget(null)}>
                            Cancel move
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Unassigned.</p>
              )}

              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field__label" htmlFor={pickerId}>
                  Add a {ROLE_LABEL[group.role]}
                </label>
                <select
                  id={pickerId}
                  className="field__input"
                  value={selectedWorkerId ?? ''}
                  onChange={(e) =>
                    setSelectedWorkerByRole((prev) => ({
                      ...prev,
                      [group.role]: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                >
                  <option value="">Select a worker…</option>
                  {eligibleForRole.map(({ worker, reason }) => (
                    <option key={worker.id} value={worker.id} disabled={reason !== null}>
                      {worker.name}
                      {reason ? ` (${reason})` : ' (available)'}
                    </option>
                  ))}
                </select>
                <p className="field__hint">
                  Ineligible workers are greyed out as a hint — the server still re-validates on submit.
                </p>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  style={{ marginTop: 'var(--space-2)' }}
                  aria-label={`Add ${ROLE_LABEL[group.role]}`}
                  disabled={selectedWorkerId === null || flow.status === 'submitting'}
                  onClick={() => void handleAdd(group.role)}
                >
                  Add
                </button>
              </div>
            </section>
          );
        })}
      </>
    );
    footer = (
      <button type="button" className="btn btn--secondary" onClick={onClose}>
        Cancel
      </button>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} titleId={titleId} title={title} footer={footer}>
      {body}
    </Modal>
  );
}
