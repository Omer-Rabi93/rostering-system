import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { installMockFetch } from '../../../src/testUtils/mockFetch.js';
import { renderWithProviders } from '../../../src/testUtils/renderWithProviders.js';
import { ShareLinkModal } from '../../../src/pages/Workers/ShareLinkModal.js';

describe('ShareLinkModal', () => {
  it('surfaces an error when rotating the link fails instead of failing silently', async () => {
    const user = userEvent.setup();
    installMockFetch([
      {
        method: 'GET',
        match: '/api/workers/2/share-link',
        respond: () => ({ status: 200, body: { url: '/schedule/tok-2' } }),
      },
      {
        method: 'POST',
        match: '/api/workers/2/share-link/rotate',
        respond: () => ({ status: 500, body: { message: 'Internal server error' } }),
      },
    ]);

    renderWithProviders(
      <ShareLinkModal isOpen workerId={2} workerName="Omer Cohen" onClose={() => {}} />,
    );

    const rotateButton = await screen.findByRole('button', { name: /Rotate link/ });
    await user.click(rotateButton);

    expect(await screen.findByText(/Could not rotate this link/)).toBeInTheDocument();
    // The dialog stays open and usable — a failed rotate is not a silent no-op.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
