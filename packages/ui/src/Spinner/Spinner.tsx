import type { ReactElement } from 'react';

export type SpinnerProps = {
  label?: string;
};

export function Spinner({ label = 'Loading' }: SpinnerProps): ReactElement {
  return <span className="spinner" role="status" aria-label={label} />;
}
