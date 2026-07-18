import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { FormField, Input, Modal } from '@rostering/ui';

export interface CompanyFormModalProps {
  readonly isOpen: boolean;
  readonly mode: 'create' | 'edit';
  readonly initialName: string;
  readonly error: string | undefined;
  readonly submitting: boolean;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}

export function CompanyFormModal(props: CompanyFormModalProps): ReactElement {
  const { isOpen, mode, initialName, error, submitting, onSubmit, onCancel } = props;
  const [name, setName] = useState(initialName);

  // Reset the field whenever a *different* company opens the modal (or it re-opens for create).
  useEffect(() => {
    if (isOpen) setName(initialName);
  }, [isOpen, initialName]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      titleId="company-form-title"
      title={mode === 'create' ? 'New company' : 'Rename company'}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting || name.trim() === ''}
            onClick={() => onSubmit(name.trim())}
          >
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(name.trim());
        }}
      >
        <FormField id="company-name" label="Name" required {...(error ? { error } : {})}>
          {(inputProps) => (
            <Input {...inputProps} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          )}
        </FormField>
      </form>
    </Modal>
  );
}
