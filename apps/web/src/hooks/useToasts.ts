import { useCallback, useRef, useState } from 'react';

export interface ToastEntry {
  readonly id: number;
  readonly variant: 'success' | 'warning' | 'error';
  readonly message: string;
}

/**
 * Shared toast-queue behavior for every page (Workers, Companies, Requirements, Roster, CSV
 * panel), so each doesn't hand-roll its own list-of-messages state. Server data is never held
 * here — a toast is a transient, page-local notification, not part of the RTK Query cache.
 * Rendered by the caller inside a single `<ToastRegion>` (from `@rostering/ui`), one `<Toast>`
 * per entry.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const pushToast = useCallback((variant: ToastEntry['variant'], message: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, variant, message }]);
    return id;
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  return { toasts, pushToast, dismissToast };
}
