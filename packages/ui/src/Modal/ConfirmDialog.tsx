import { useId } from 'react';
import type { ReactNode } from 'react';

import { Modal } from './Modal';

export type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Set false for the informational "notice" shape (component-inventory.md's Companies
   * delete-blocked and Roster 422-hard-block/publish-blocked dialogs): a single acknowledgement
   * button, no Cancel — there is nothing to opt out of, only to dismiss. Defaults true (the
   * normal two-button confirm/cancel shape for 409 `confirmRequired` flows). */
  showCancel?: boolean;
  /** Disables the confirm button — the CSV full-sync warning (component-inventory.md) requires
   * an explicit "I understand…" acknowledgement checkbox before its destructive "Import" action
   * is available; this lets the page wire that gate without forking the component. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A Modal preconfigured as a confirmation prompt: fixed Cancel/Confirm
 * footer. This is the UI shape for every `409 confirmRequired` API response
 * (soft-rule warnings) and the CSV full-sync warning, so `onCancel` must
 * never apply the pending change — only `onConfirm` does. Escape and
 * clicking Cancel are equivalent (both dismiss via `onCancel`, courtesy of
 * Modal wiring `onClose` to `onCancel`).
 */
export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element | null {
  const {
    isOpen,
    title,
    body,
    confirmLabel,
    cancelLabel = 'Cancel',
    destructive = false,
    showCancel = true,
    confirmDisabled = false,
    onConfirm,
    onCancel,
  } = props;
  const titleId = useId();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      titleId={titleId}
      title={title}
      size="sm"
      footer={
        <>
          {showCancel ? (
            <button type="button" className="btn" onClick={onCancel}>
              {cancelLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn ${destructive ? 'btn--danger' : 'btn--primary'}`}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
