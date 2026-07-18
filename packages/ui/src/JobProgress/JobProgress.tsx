import type { ReactElement } from 'react';

export type JobProgressProps = {
  state: 'created' | 'active' | 'completed' | 'failed';
  label: string;
  percent?: number;
  errorMessage?: string;
};

export function JobProgress(props: JobProgressProps): ReactElement {
  const { state, label, percent, errorMessage } = props;

  return (
    <div className={`job-progress job-progress--${state}`}>
      <span className="spinner" aria-hidden="true" />
      <div className="job-progress__bar" aria-hidden="true">
        <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </div>
      <span role="status" aria-live="polite">
        {label}
        {state === 'failed' && errorMessage !== undefined ? ` ${errorMessage}` : ''}
      </span>
    </div>
  );
}
