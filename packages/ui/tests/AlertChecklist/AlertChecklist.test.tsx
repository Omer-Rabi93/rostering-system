import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AlertChecklist } from '../../src/AlertChecklist/AlertChecklist';

const alerts = [
  {
    id: 1,
    type: 'unfillable_slot' as const,
    detail: 'Aug 12 · Shift B · Supervisor — 1 short',
    acknowledged: false,
  },
  {
    id: 2,
    type: 'min_hours_shortfall' as const,
    detail: 'Jane Doe — 6 hrs short this period',
    acknowledged: true,
  },
];

describe('AlertChecklist', () => {
  it("names each checkbox with the alert's detail text, not a generic label", () => {
    render(<AlertChecklist alerts={alerts} onAcknowledge={vi.fn()} />);

    expect(
      screen.getByRole('checkbox', { name: /Aug 12 · Shift B · Supervisor — 1 short/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /Jane Doe — 6 hrs short this period/ }),
    ).toBeInTheDocument();
  });

  it('calls onAcknowledge with the correct alertId when a checkbox is clicked', async () => {
    const user = userEvent.setup();
    const onAcknowledge = vi.fn();

    render(<AlertChecklist alerts={alerts} onAcknowledge={onAcknowledge} />);

    await user.click(screen.getByRole('checkbox', { name: /Aug 12 · Shift B · Supervisor/ }));

    expect(onAcknowledge).toHaveBeenCalledWith(1);
  });

  it('renders checkboxes checked when acknowledged is true, unchecked when false', () => {
    render(<AlertChecklist alerts={alerts} onAcknowledge={vi.fn()} />);

    expect(
      screen.getByRole('checkbox', { name: /Aug 12 · Shift B · Supervisor/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /Jane Doe — 6 hrs short this period/ }),
    ).toBeChecked();
  });
});
