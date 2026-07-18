import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Toast } from './Toast';

describe('Toast', () => {
  it('renders the message with the variant class and a hidden icon', () => {
    render(<Toast variant="success" message="August 2026 published." />);

    const message = screen.getByText('August 2026 published.');
    const toast = message.closest('.toast');
    expect(toast).not.toBeNull();
    expect(toast).toHaveClass('toast', 'toast--success');

    const icon = toast?.querySelector('.toast__icon');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not render a dismiss button when no onDismiss is given', () => {
    render(<Toast variant="success" message="August 2026 published." />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a dismiss button with an accessible name and calls onDismiss when clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Toast variant="error" message="Could not save." onDismiss={onDismiss} />,
    );

    const button = screen.getByRole('button', { name: 'Dismiss' });
    await user.click(button);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
