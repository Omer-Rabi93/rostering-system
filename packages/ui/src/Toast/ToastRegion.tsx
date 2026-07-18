import type { ReactElement, ReactNode } from 'react';

export type ToastRegionProps = {
  children?: ReactNode;
};

export function ToastRegion({ children }: ToastRegionProps): ReactElement {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {children}
    </div>
  );
}
