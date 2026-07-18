import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  it('fires onChange with the typed value', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<Input aria-label="Full name" value="" onChange={handleChange} />);

    const input = screen.getByRole('textbox', { name: 'Full name' });
    await user.type(input, 'Ada');

    expect(handleChange).toHaveBeenCalledTimes(3);
  });

  it('passes through id, aria-invalid, and aria-describedby exactly as given (never computes them)', () => {
    render(
      <Input
        aria-label="Hourly rate"
        id="hourly-rate"
        aria-invalid={true}
        aria-describedby="hourly-rate-error"
        type="number"
        inputMode="decimal"
        value=""
        onChange={() => {}}
      />,
    );

    const input = screen.getByRole('spinbutton', { name: 'Hourly rate' });
    expect(input).toHaveAttribute('id', 'hourly-rate');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'hourly-rate-error');
    expect(input).toHaveAttribute('inputmode', 'decimal');
  });
});
