import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../../src/Modal/ConfirmDialog';

describe('ConfirmDialog', () => {
  it('calls onConfirm (and not onCancel) when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen
        title="Overwrite existing shifts?"
        body={<p>This will overwrite 3 shifts.</p>}
        confirmLabel="Save anyway"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save anyway' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel (and not onConfirm) when the cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen
        title="Overwrite existing shifts?"
        body={<p>This will overwrite 3 shifts.</p>}
        confirmLabel="Save anyway"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onCancel (and not onConfirm) when Escape is pressed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen
        title="Overwrite existing shifts?"
        body={<p>This will overwrite 3 shifts.</p>}
        confirmLabel="Save anyway"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders the confirm button with btn--danger (not btn--primary) when destructive is true', () => {
    render(
      <ConfirmDialog
        isOpen
        title="Set employee inactive?"
        body={<p>This employee has future shifts assigned.</p>}
        confirmLabel="Set Inactive and import"
        destructive
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const confirmButton = screen.getByRole('button', { name: 'Set Inactive and import' });
    expect(confirmButton).toHaveClass('btn--danger');
    expect(confirmButton).not.toHaveClass('btn--primary');
  });

  it('renders the confirm button with btn--primary (not btn--danger) when destructive is not set', () => {
    render(
      <ConfirmDialog
        isOpen
        title="Save changes?"
        body={<p>Some soft-rule warnings apply.</p>}
        confirmLabel="Save anyway"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const confirmButton = screen.getByRole('button', { name: 'Save anyway' });
    expect(confirmButton).toHaveClass('btn--primary');
    expect(confirmButton).not.toHaveClass('btn--danger');
  });

  it('renders a default cancel label of "Cancel" and honors a custom cancelLabel', () => {
    render(
      <ConfirmDialog
        isOpen
        title="Import CSV?"
        body={<p>This will fully sync employees.</p>}
        confirmLabel="Continue"
        cancelLabel="Go back"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('renders only the single acknowledgement button, no Cancel, when showCancel is false', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen
        title="Can't publish yet"
        body={<p>3 alerts are still unacknowledged.</p>}
        confirmLabel="OK"
        showCancel={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    const okButton = screen.getByRole('button', { name: 'OK' });
    await user.click(okButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables the confirm button when confirmDisabled is true, and clicking it does nothing', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <ConfirmDialog
        isOpen
        title="Confirm import — full workforce sync"
        body={<p>Workers not in this file will be set Inactive.</p>}
        confirmLabel="Import file.csv"
        destructive
        confirmDisabled
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    const importButton = screen.getByRole('button', { name: 'Import file.csv' });
    expect(importButton).toBeDisabled();
    await user.click(importButton);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
