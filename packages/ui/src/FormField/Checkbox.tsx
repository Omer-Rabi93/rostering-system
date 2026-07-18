import type { InputHTMLAttributes } from 'react';

// Renders just the bare `<input type="checkbox">` with props spread through —
// no `.field-checkbox` wrapper or inline visible label here. `.field-checkbox`
// is a *layout* class for the "icon/checkbox + inline visible text" pattern;
// composing that visible label is the caller's job (e.g. a checklist item
// wrapping this in its own <label> or flex row). Keeping Checkbox unopinionated
// about layout is what lets a later phase compose 21 of these into a 7x3
// availability matrix, each with its own `aria-label` and no redundant visible
// text repeated 21 times.
export type CheckboxProps = InputHTMLAttributes<HTMLInputElement>;

export function Checkbox(props: CheckboxProps) {
  return <input type="checkbox" {...props} />;
}
