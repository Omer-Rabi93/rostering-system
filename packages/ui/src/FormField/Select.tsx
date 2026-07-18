import type { SelectHTMLAttributes } from 'react';

export type SelectOption = {
  value: string;
  label: string;
};

// Thin wrapper: like Input, never computes id/aria-invalid/aria-describedby —
// those only arrive as pass-through props from the caller (typically
// FormField's render prop).
export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  options: SelectOption[];
};

export function Select({ options, ...props }: SelectProps) {
  return (
    <select className="field__input" {...props}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
