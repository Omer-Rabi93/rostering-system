import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Spinner } from '../../src/Spinner/Spinner';

describe('Spinner', () => {
  it('renders a status role with the default "Loading" accessible name', () => {
    render(<Spinner />);

    const spinner = screen.getByRole('status', { name: 'Loading' });
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveClass('spinner');
  });

  it('overrides the accessible name when a custom label is given', () => {
    render(<Spinner label="Saving worker" />);

    expect(screen.getByRole('status', { name: 'Saving worker' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });
});
