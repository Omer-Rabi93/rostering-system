import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from './Badge';

describe('Badge', () => {
  it('renders a role badge with a human-readable label and the role class', () => {
    render(<Badge kind="role" value="GENERAL_GUARD" />);

    const badge = screen.getByText('General Guard');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('badge', 'badge--role-guard');
  });

  it('renders a status badge with a human-readable label and the status class', () => {
    render(<Badge kind="status" value="PUBLISHED" />);

    const badge = screen.getByText('Published');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('badge', 'badge--status-published');
  });

  it('renders a shift badge showing only the letter by default', () => {
    render(<Badge kind="shift" value="A" />);

    const badge = screen.getByText('A');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('badge', 'badge--shift-a');
  });

  it('renders a shift badge with the hour range when showHours is true', () => {
    render(<Badge kind="shift" value="B" showHours />);

    const badge = screen.getByText('B · 08–16');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('badge', 'badge--shift-b');
  });

  it('renders a severity badge with a human-readable label and the severity class', () => {
    render(<Badge kind="severity" value="blocking" />);

    const badge = screen.getByText('Blocking');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('badge', 'badge--severity-blocking');
  });
});
