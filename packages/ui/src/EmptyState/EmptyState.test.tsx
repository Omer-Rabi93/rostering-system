import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders the title inside an empty-state container', () => {
    render(<EmptyState title="No companies yet" />);

    const container = screen.getByText('No companies yet').closest('.empty-state');
    expect(container).not.toBeNull();
    expect(screen.getByText('No companies yet')).toHaveClass('empty-state__title');
  });

  it('does not render an icon element when no icon prop is given', () => {
    const { container } = render(<EmptyState title="No companies yet" />);

    expect(container.querySelector('.empty-state__icon')).toBeNull();
  });

  it('renders the icon inside .empty-state__icon when given', () => {
    render(<EmptyState title="No companies yet" icon={<span>🏢</span>} />);

    const icon = screen.getByText('🏢');
    expect(icon.closest('.empty-state__icon')).not.toBeNull();
  });

  it('renders the body text inside .empty-state__body when given', () => {
    render(<EmptyState title="No companies yet" body="Add at least one company." />);

    expect(screen.getByText('Add at least one company.')).toHaveClass('empty-state__body');
  });

  it('does not render a body element when no body prop is given', () => {
    const { container } = render(<EmptyState title="No companies yet" />);

    expect(container.querySelector('.empty-state__body')).toBeNull();
  });

  it('renders an action button and calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <EmptyState title="No companies yet" action={{ label: '+ New company', onClick }} />,
    );

    const button = screen.getByRole('button', { name: '+ New company' });
    expect(button).toHaveClass('btn', 'btn--primary');

    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not render a button when no action prop is given', () => {
    render(<EmptyState title="No companies yet" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
