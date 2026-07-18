import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { JobProgress } from './JobProgress';

describe('JobProgress', () => {
  it('renders the label text inside an element with role="status"', () => {
    render(<JobProgress state="active" label="Generating roster for 2026-08…" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Generating roster for 2026-08…');
  });

  it('updates the announced text when state and label change', () => {
    const { rerender } = render(<JobProgress state="active" label="Working…" />);

    expect(screen.getByRole('status')).toHaveTextContent('Working…');

    rerender(<JobProgress state="completed" label="Done!" />);

    expect(screen.getByRole('status')).toHaveTextContent('Done!');
    expect(screen.getByRole('status')).not.toHaveTextContent('Working…');
  });

  it('surfaces errorMessage when state is failed', () => {
    render(
      <JobProgress
        state="failed"
        label="Generating roster for 2026-08…"
        errorMessage="Solver timed out after 60s"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Solver timed out after 60s');
  });
});
