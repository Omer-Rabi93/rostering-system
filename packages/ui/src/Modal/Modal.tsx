import { useRef } from 'react';
import type { MouseEvent, ReactNode, RefObject } from 'react';

import { useFocusTrap } from './useFocusTrap';

export type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  titleId: string;
  title: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  initialFocusRef?: RefObject<HTMLElement>;
  children: ReactNode;
  footer?: ReactNode;
};

export function Modal(props: ModalProps): React.JSX.Element | null {
  const { isOpen, onClose, titleId, title, size = 'md', initialFocusRef, children, footer } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap({ isOpen, onClose, dialogRef, ...(initialFocusRef ? { initialFocusRef } : {}) });

  if (!isOpen) return null;

  function handleOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <div className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal__close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
