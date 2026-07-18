import type { InputHTMLAttributes } from 'react';

// `type` is narrowed to the two variants this design system supports today
// (plain text and numeric entry); everything else (id, aria-*, value,
// onChange, inputMode, ...) is standard InputHTMLAttributes and simply
// spread through. Input never computes id/aria-invalid/aria-describedby
// itself — those only ever arrive as props from the caller (typically
// FormField's render prop), so the label/error association can't drift.
export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  type?: 'text' | 'number';
};

export function Input({ type = 'text', ...props }: InputProps) {
  return <input type={type} className="field__input" {...props} />;
}
