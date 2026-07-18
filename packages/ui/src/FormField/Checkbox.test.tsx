import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('is queryable by its aria-label and toggles via mouse click', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<Checkbox aria-label="Available Monday, Shift B" checked={false} onChange={handleChange} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Available Monday, Shift B' });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('toggles via the keyboard (Tab to focus, then Space)', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(<Checkbox aria-label="Available Tuesday, Shift A" checked={false} onChange={handleChange} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Available Tuesday, Shift A' });

    await user.tab();
    expect(checkbox).toHaveFocus();

    await user.keyboard(' ');

    expect(handleChange).toHaveBeenCalledTimes(1);
  });
});
