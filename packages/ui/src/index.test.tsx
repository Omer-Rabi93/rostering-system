import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('@rostering/ui', () => {
  it('is set up and able to render + test React components', () => {
    render(<p>placeholder</p>);
    expect(screen.getByText('placeholder')).toBeInTheDocument();
  });
});
