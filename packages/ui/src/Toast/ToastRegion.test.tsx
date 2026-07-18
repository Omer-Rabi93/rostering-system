import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Toast } from './Toast';
import { ToastRegion } from './ToastRegion';

describe('ToastRegion', () => {
  it('renders a toast appended into the region as a queryable live status region', () => {
    render(
      <ToastRegion>
        <Toast variant="success" message="August 2026 published." />
      </ToastRegion>,
    );

    const region = screen.getByRole('status');
    expect(region).toHaveClass('toast-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('August 2026 published.');
  });

  it('keeps a single live region when a second toast is appended', () => {
    const { rerender } = render(
      <ToastRegion>
        <Toast variant="success" message="August 2026 published." />
      </ToastRegion>,
    );

    rerender(
      <ToastRegion>
        <Toast variant="success" message="August 2026 published." />
        <Toast variant="error" message="Could not save." />
      </ToastRegion>,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    const region = screen.getByRole('status');
    expect(within(region).getByText('August 2026 published.')).toBeInTheDocument();
    expect(within(region).getByText('Could not save.')).toBeInTheDocument();
  });
});
