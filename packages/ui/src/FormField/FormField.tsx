import type { ReactNode } from 'react';

/** Props FormField passes into its `children` render-prop, to be spread onto the
 * caller's own input/select. Only the applicable optional keys are ever set
 * (never set to `undefined`), per `exactOptionalPropertyTypes`. */
export type FormFieldInputProps = {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
};

export type FormFieldProps = {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: (inputProps: FormFieldInputProps) => ReactNode;
};

export function FormField({ id, label, required, hint, error, children }: FormFieldProps): ReactNode {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedByIds = [hint ? hintId : null, error ? errorId : null].filter(
    (candidate): candidate is string => candidate !== null,
  );
  const describedBy = describedByIds.length > 0 ? describedByIds.join(' ') : undefined;

  const inputProps: FormFieldInputProps = {
    id,
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  };

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? <span className="req">*</span> : null}
      </label>
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      {children(inputProps)}
    </div>
  );
}
