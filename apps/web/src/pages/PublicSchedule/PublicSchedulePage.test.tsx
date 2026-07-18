import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../testUtils/mockFetch.js';
import { PublicSchedulePage } from './PublicSchedulePage.js';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/schedule/:token" element={<PublicSchedulePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PublicSchedulePage', () => {
  it("renders the worker's own name and shifts for a published month — no PII beyond that", async () => {
    installMockFetch([
      {
        method: 'GET',
        match: /^\/api\/schedule\/good-token/,
        respond: () => ({
          status: 200,
          body: {
            name: 'Dana Levi',
            month: '2026-08',
            shifts: [
              { date: '2026-08-01', shiftType: 'A' },
              { date: '2026-08-03', shiftType: 'B' },
            ],
          },
        }),
      },
    ]);

    renderAt('/schedule/good-token');

    // Both a `.print-only` heading and the on-screen toolbar heading render the worker's name
    // (the former only visible under print media) — either confirms the name rendered.
    expect(await screen.findAllByRole('heading', { name: 'Dana Levi' })).not.toHaveLength(0);
    expect(screen.getByText((_, el) => el?.textContent === 'Total shifts: 2')).toBeInTheDocument();
    // Never a national-ID-shaped value, hourly rate, or any other worker's name/shifts — only the
    // reassuring disclaimer text ("never national ID...") is allowed to mention "national".
    expect(screen.queryByText(/\b\d{9}\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/₪/)).not.toBeInTheDocument();
    expect(screen.queryByText('Omer Cohen')).not.toBeInTheDocument();
  });

  it('shows a "no shifts published" empty state (keeping the worker name) for a published month with zero assigned shifts', async () => {
    installMockFetch([
      {
        method: 'GET',
        match: /^\/api\/schedule\/good-token/,
        respond: () => ({ status: 200, body: { name: 'Omer Cohen', month: '2026-08', shifts: [] } }),
      },
    ]);

    renderAt('/schedule/good-token');
    await screen.findAllByRole('heading', { name: 'Omer Cohen' });

    expect(await screen.findByText(/No shifts published for/)).toBeInTheDocument();
  });

  it('shows the generic "link isn\'t valid" state for an unknown/rotated token (404, indistinguishable from any other 404)', async () => {
    installMockFetch([
      { method: 'GET', match: /^\/api\/schedule\/bad-token/, respond: () => ({ status: 404, body: { message: 'Not found' } }) },
    ]);

    renderAt('/schedule/bad-token');

    expect(await screen.findByText("This link isn't valid")).toBeInTheDocument();
  });
});
