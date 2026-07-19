import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../../src/FormField/Select';

describe('Select', () => {
  it('renders visible option labels and fires onChange when a new option is selected', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    render(
      <Select
        aria-label="Role"
        value="guard"
        onChange={handleChange}
        options={[
          { value: 'guard', label: 'Guard' },
          { value: 'supervisor', label: 'Supervisor' },
        ]}
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Role' });
    expect(screen.getByRole('option', { name: 'Supervisor' })).toBeInTheDocument();

    await user.selectOptions(select, 'supervisor');

    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('passes through id, aria-invalid, and aria-describedby exactly as given (never computes them)', () => {
    render(
      <Select
        aria-label="Role"
        id="role"
        aria-invalid={true}
        aria-describedby="role-error"
        value="guard"
        onChange={() => {}}
        options={[{ value: 'guard', label: 'Guard' }]}
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Role' });
    expect(select).toHaveAttribute('id', 'role');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAttribute('aria-describedby', 'role-error');
  });
});
