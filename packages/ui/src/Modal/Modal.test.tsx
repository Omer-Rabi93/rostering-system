import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from './Modal';

describe('Modal', () => {
  it('renders a dialog with role="dialog", aria-modal="true", and aria-labelledby pointing at the title', () => {
    render(
      <Modal isOpen onClose={() => {}} titleId="my-modal-title" title="My Modal">
        <p>Body content</p>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'my-modal-title');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    const titleEl = document.getElementById(labelledBy as string);
    expect(titleEl).not.toBeNull();
    expect(titleEl).toHaveTextContent('My Modal');
  });

  it('moves initial focus to the first focusable element inside the dialog when it opens (the header close button, in DOM order)', () => {
    render(
      <Modal isOpen onClose={() => {}} titleId="my-modal-title" title="My Modal">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Modal>,
    );

    expect(document.activeElement).toHaveAttribute('aria-label', 'Close');
  });

  it('renders nothing when isOpen is false', () => {
    render(
      <Modal isOpen={false} onClose={() => {}} titleId="my-modal-title" title="My Modal">
        <p>Body content</p>
      </Modal>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Body content')).not.toBeInTheDocument();
  });

  it('moves initial focus to initialFocusRef.current when supplied, overriding the default target', () => {
    function Harness() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Modal isOpen onClose={() => {}} titleId="my-modal-title" title="My Modal" initialFocusRef={inputRef}>
          <button type="button">First</button>
          <input ref={inputRef} aria-label="Target input" />
        </Modal>
      );
    }

    render(<Harness />);

    expect(document.activeElement).toHaveAttribute('aria-label', 'Target input');
  });

  it('restores focus to the element that was focused before the modal opened, after it closes', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setIsOpen(true)}>
            Open modal
          </button>
          <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} titleId="my-modal-title" title="My Modal">
            <p>Body content</p>
          </Modal>
        </>
      );
    }

    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Open modal' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(trigger);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('calls onClose when Escape is pressed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Modal isOpen onClose={onClose} titleId="my-modal-title" title="My Modal">
        <p>Body content</p>
      </Modal>,
    );

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab from the last focusable element to the first, and Shift+Tab from the first to the last', async () => {
    const user = userEvent.setup();

    render(
      <Modal isOpen onClose={() => {}} titleId="my-modal-title" title="My Modal">
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>,
    );

    const closeButton = screen.getByRole('button', { name: 'Close' });
    const lastButton = screen.getByRole('button', { name: 'Last' });

    // Initial focus lands on the close button (first focusable in DOM order).
    expect(document.activeElement).toBe(closeButton);

    // Shift+Tab from the first focusable element wraps to the last.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(lastButton);

    // Tab from the last focusable element wraps back to the first.
    await user.tab();
    expect(document.activeElement).toBe(closeButton);
  });

  it('calls onClose when clicking the overlay background, but not when clicking inside the modal card', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Modal isOpen onClose={onClose} titleId="my-modal-title" title="My Modal">
        <p>Body content</p>
      </Modal>,
    );

    await user.click(screen.getByText('Body content'));
    expect(onClose).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    const overlay = dialog.parentElement as HTMLElement;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
