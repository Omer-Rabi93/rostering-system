import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export type UseFocusTrapOptions = {
  isOpen: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLElement>;
  initialFocusRef?: RefObject<HTMLElement>;
};

/**
 * Ports the vanilla-JS focus-trap behavior from docs/design/ui/kit.js
 * (openModal/closeModal) into a React hook:
 *  - captures the element that had focus right before the dialog opened
 *  - moves focus into the dialog on open (initialFocusRef, else first
 *    focusable element, else the dialog container itself)
 *  - restores focus to the captured element when the dialog closes
 *  - traps Tab/Shift+Tab within the dialog's focusable elements
 *  - calls onClose on Escape
 */
export function useFocusTrap({ isOpen, onClose, dialogRef, initialFocusRef }: UseFocusTrapOptions): void {
  // Move focus in on open; restore focus to whatever was focused before, on close.
  useEffect(() => {
    if (!isOpen) return;

    const returnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const dialog = dialogRef.current;
    if (dialog) {
      const focusables = getFocusable(dialog);
      const target = initialFocusRef?.current ?? focusables[0] ?? dialog;
      target.focus();
    }

    return () => {
      if (returnEl && typeof returnEl.focus === 'function') {
        returnEl.focus();
      }
    };
  }, [isOpen, dialogRef, initialFocusRef]);

  // Escape closes; Tab/Shift+Tab wraps focus within the dialog.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;

        const items = getFocusable(dialog);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [isOpen, onClose, dialogRef]);
}
