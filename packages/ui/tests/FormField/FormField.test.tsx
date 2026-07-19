import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormField } from '../../src/FormField/FormField';
import { Input } from '../../src/FormField/Input';

describe('FormField', () => {
  it('renders a label associated with the wrapped input via htmlFor/id', () => {
    render(
      <FormField id="employee-name" label="Employee name">
        {(inputProps) => <input {...inputProps} />}
      </FormField>,
    );

    const input = screen.getByLabelText('Employee name');
    expect(input).toHaveAttribute('id', 'employee-name');
  });

  it('renders visible hint text associated with the input via aria-describedby', () => {
    render(
      <FormField id="employee-name" label="Employee name" hint="As it appears on payroll">
        {(inputProps) => <input {...inputProps} />}
      </FormField>,
    );

    const input = screen.getByLabelText('Employee name');
    const hint = screen.getByText('As it appears on payroll');
    expect(hint).toHaveAttribute('id', 'employee-name-hint');
    expect(input).toHaveAttribute('aria-describedby', 'employee-name-hint');
  });

  it('sets aria-invalid and aria-describedby, and renders an alert, when error is present', () => {
    render(
      <FormField id="employee-name" label="Employee name" error="Name is required">
        {(inputProps) => <input {...inputProps} />}
      </FormField>,
    );

    const input = screen.getByLabelText('Employee name');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Name is required');
    expect(alert).toHaveAttribute('id', 'employee-name-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'employee-name-error');
  });

  it('space-joins hint and error ids in aria-describedby when both are present', () => {
    render(
      <FormField
        id="employee-name"
        label="Employee name"
        hint="As it appears on payroll"
        error="Name is required"
      >
        {(inputProps) => <input {...inputProps} />}
      </FormField>,
    );

    const input = screen.getByLabelText('Employee name');
    expect(input).toHaveAttribute('aria-describedby', 'employee-name-hint employee-name-error');
  });

  it('omits aria-describedby entirely when neither hint nor error is present', () => {
    render(
      <FormField id="employee-name" label="Employee name">
        {(inputProps) => <input {...inputProps} />}
      </FormField>,
    );

    const input = screen.getByLabelText('Employee name');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('shows a visible required marker when required is true', () => {
    render(
      <FormField id="employee-name" label="Employee name" required>
        {(inputProps) => <input {...inputProps} />}
      </FormField>,
    );

    const label = screen.getByText('Employee name').closest('label');
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent('*');
    expect(label?.querySelector('.req')).not.toBeNull();
  });

  it('wires a real Input as the child: label, aria-invalid, and aria-describedby all stay in sync', () => {
    render(
      <FormField id="hourly-rate" label="Hourly rate" error="Must be positive">
        {(inputProps) => <Input {...inputProps} type="number" value="" onChange={() => {}} />}
      </FormField>,
    );

    const input = screen.getByRole('spinbutton', { name: 'Hourly rate' });
    expect(input).toHaveAttribute('id', 'hourly-rate');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'hourly-rate-error');
    expect(input).toHaveClass('field__input');
  });
});
