import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { FormField, Input, Modal, Select } from '@rostering/ui';
import { ROLES, WORKER_STATUSES } from '@rostering/shared';
import type { Contract, Role, WorkerStatus } from '@rostering/shared';

import {
  useCreateWorkerMutation,
  useUpdateWorkerMutation,
  useUpsertWorkerContractMutation,
  type WorkerDto,
} from '../../api/workers.api.js';
import { classifyMutationError } from '../../api/errors.js';
import { validateNationalId } from './nationalId.js';

const ROLE_OPTIONS = ROLES.map((role) => ({
  value: role,
  label: { GENERAL_GUARD: 'General Guard', SUPERVISOR: 'Supervisor', SCREENER: 'Screener' }[role],
}));

const STATUS_OPTIONS = WORKER_STATUSES.map((status) => ({
  value: status,
  label: status === 'ACTIVE' ? 'Active' : 'Inactive',
}));

interface FormFields {
  nationalId: string;
  name: string;
  companyId: string;
  role: Role;
  status: WorkerStatus;
  hourlyCostIls: string;
  minMonthlyHours: string;
  maxMonthlyHours: string;
}

function initialFields(worker: WorkerDto | null, activeCompanyId: number): FormFields {
  if (worker) {
    return {
      nationalId: worker.nationalId,
      name: worker.name,
      companyId: String(worker.companyId),
      role: worker.role,
      status: worker.status,
      hourlyCostIls: worker.contract ? String(worker.contract.hourlyCostIls) : '',
      minMonthlyHours: worker.contract ? String(worker.contract.minMonthlyHours) : '',
      maxMonthlyHours: worker.contract ? String(worker.contract.maxMonthlyHours) : '',
    };
  }
  return {
    nationalId: '',
    name: '',
    companyId: String(activeCompanyId),
    role: 'GENERAL_GUARD',
    status: 'ACTIVE',
    hourlyCostIls: '',
    minMonthlyHours: '',
    maxMonthlyHours: '',
  };
}

export interface WorkerFormModalProps {
  readonly isOpen: boolean;
  readonly worker: WorkerDto | null; // null = create mode
  readonly companyId: number; // active company from the topbar
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}

export function WorkerFormModal(props: WorkerFormModalProps): ReactElement {
  const { isOpen, worker, companyId, onSaved, onCancel } = props;

  const [createWorker, createResult] = useCreateWorkerMutation();
  const [updateWorker, updateResult] = useUpdateWorkerMutation();
  const [upsertContract] = useUpsertWorkerContractMutation();

  const [fields, setFields] = useState<FormFields>(() => initialFields(worker, companyId));
  const [touched, setTouched] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (isOpen) {
      setFields(initialFields(worker, companyId));
      setTouched(false);
      setSubmitError(undefined);
    }
    // Re-initialize whenever a different worker (or create mode) opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, worker?.id]);

  const nationalIdError = touched ? (validateNationalId(fields.nationalId) ?? undefined) : undefined;
  const minMax = Number(fields.minMonthlyHours);
  const maxMonthly = Number(fields.maxMonthlyHours);
  const minMaxError =
    touched && fields.minMonthlyHours !== '' && fields.maxMonthlyHours !== '' && minMax > maxMonthly
      ? `Min monthly hours (${minMax}) must be less than or equal to max (${maxMonthly}).`
      : undefined;

  const submitting = createResult.isLoading || updateResult.isLoading;

  async function handleSubmit() {
    setTouched(true);
    setSubmitError(undefined);

    const nidError = validateNationalId(fields.nationalId);
    if (nidError || fields.name.trim() === '') return;
    if (fields.hourlyCostIls === '' || fields.minMonthlyHours === '' || fields.maxMonthlyHours === '') return;
    if (Number(fields.minMonthlyHours) > Number(fields.maxMonthlyHours)) return;

    const workerBody = {
      nationalId: fields.nationalId,
      name: fields.name.trim(),
      role: fields.role,
      status: fields.status,
      companyId: Number(fields.companyId),
    };
    const contractBody: Contract = {
      hourlyCostIls: Number(fields.hourlyCostIls),
      minMonthlyHours: Number(fields.minMonthlyHours),
      maxMonthlyHours: Number(fields.maxMonthlyHours),
    };

    try {
      const savedWorker = worker
        ? await updateWorker({ id: worker.id, body: workerBody }).unwrap()
        : await createWorker(workerBody).unwrap();
      await upsertContract({ workerId: savedWorker.id, body: contractBody }).unwrap();
      onSaved();
    } catch (err) {
      const classified = classifyMutationError(err);
      if (classified.kind !== 'conflictMessage') {
        setSubmitError('Could not save this worker. Please try again.');
      }
      // Duplicate-nationalId (409 conflictMessage) is surfaced inline below via
      // `duplicateIdError`, computed from the mutation's own error state.
    }
  }

  const mutationError = worker ? updateResult.error : createResult.error;
  const duplicateIdError =
    classifyMutationError(mutationError).kind === 'conflictMessage'
      ? `National ID ${fields.nationalId} already belongs to another worker.`
      : undefined;
  const nationalIdFieldError = duplicateIdError ?? nationalIdError;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      titleId="worker-form-title"
      title={worker ? `Edit worker — ${worker.name}` : 'New worker'}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={submitting} onClick={() => void handleSubmit()}>
            {worker ? 'Save changes' : 'Save worker'}
          </button>
        </>
      }
    >
      {submitError ? (
        <div className="toast toast--error" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
          <span className="toast__icon" aria-hidden="true">
            ✕
          </span>
          <span>{submitError}</span>
        </div>
      ) : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="form-grid">
          <FormField
            id="w-nid"
            label="National ID"
            required
            hint="9-digit Israeli ID, checksum-validated. Shorter values are zero-padded."
            {...(nationalIdFieldError ? { error: nationalIdFieldError } : {})}
          >
            {(inputProps) => (
              <Input
                {...inputProps}
                value={fields.nationalId}
                maxLength={9}
                inputMode="numeric"
                onChange={(e) => setFields((f) => ({ ...f, nationalId: e.target.value }))}
              />
            )}
          </FormField>

          <FormField id="w-name" label="Full name" required {...(touched && fields.name.trim() === '' ? { error: 'Name is required.' } : {})}>
            {(inputProps) => (
              <Input {...inputProps} value={fields.name} maxLength={120} onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))} />
            )}
          </FormField>

          <FormField id="w-role" label="Role" required>
            {(inputProps) => (
              <Select
                {...inputProps}
                value={fields.role}
                options={ROLE_OPTIONS}
                onChange={(e) => setFields((f) => ({ ...f, role: e.target.value as Role }))}
              />
            )}
          </FormField>

          <FormField id="w-status" label="Status" required>
            {(inputProps) => (
              <Select
                {...inputProps}
                value={fields.status}
                options={STATUS_OPTIONS}
                onChange={(e) => setFields((f) => ({ ...f, status: e.target.value as WorkerStatus }))}
              />
            )}
          </FormField>

          <FormField id="w-cost" label="Hourly cost, ILS" required>
            {(inputProps) => (
              <Input
                {...inputProps}
                type="number"
                inputMode="decimal"
                value={fields.hourlyCostIls}
                onChange={(e) => setFields((f) => ({ ...f, hourlyCostIls: e.target.value }))}
              />
            )}
          </FormField>

          <FormField id="w-min" label="Min monthly hours" required {...(minMaxError ? { error: minMaxError } : {})}>
            {(inputProps) => (
              <Input
                {...inputProps}
                type="number"
                inputMode="numeric"
                value={fields.minMonthlyHours}
                onChange={(e) => setFields((f) => ({ ...f, minMonthlyHours: e.target.value }))}
              />
            )}
          </FormField>

          <FormField id="w-max" label="Max monthly hours" required {...(minMaxError ? { error: minMaxError } : {})}>
            {(inputProps) => (
              <Input
                {...inputProps}
                type="number"
                inputMode="numeric"
                value={fields.maxMonthlyHours}
                onChange={(e) => setFields((f) => ({ ...f, maxMonthlyHours: e.target.value }))}
              />
            )}
          </FormField>
        </div>
      </form>
    </Modal>
  );
}
