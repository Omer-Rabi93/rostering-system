import type { ReactElement } from 'react';

export type ToastProps = {
  variant: 'success' | 'warning' | 'error';
  message: string;
  onDismiss?: () => void;
};

const ICON: Record<'success' | 'warning' | 'error', string> = {
  success: '✓',
  warning: '⚠',
  error: '✕',
};

export function Toast({ variant, message, onDismiss }: ToastProps): ReactElement {
  return (
    <div className={`toast toast--${variant}`}>
      <span className="toast__icon" aria-hidden="true">
        {ICON[variant]}
      </span>
      <span>{message}</span>
      {onDismiss ? (
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      ) : null}
    </div>
  );
}
