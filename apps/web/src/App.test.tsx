import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';
import { createAppStore } from './store/index.js';
import { installMockFetch } from './testUtils/mockFetch.js';

describe('App', () => {
  it('redirects "/" to the Workers page, rendered inside the authenticated Layout shell', async () => {
    installMockFetch([
      { method: 'GET', match: '/api/workers', respond: () => ({ status: 200, body: [] }) },
      { method: 'GET', match: '/api/companies', respond: () => ({ status: 200, body: [] }) },
    ]);

    render(
      <Provider store={createAppStore()}>
        <App />
      </Provider>,
    );

    expect(screen.getByText('ICTS Rostering')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Workers' })).toBeInTheDocument();
  });
});
