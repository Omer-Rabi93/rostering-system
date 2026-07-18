import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { createAppStore } from '../store/index.js';

/** Renders a page/component wrapped in a fresh Redux store (own RTK Query cache — see
 * `createAppStore`'s doc comment) and a `MemoryRouter`, the combination every page-level test
 * needs. `initialEntries` lets a test start on a specific route (e.g. `/roster/2026-08`).
 *
 * `path` (default `"*"`, matching anything) is mounted as a real `<Route path={path}
 * element={ui}/>` rather than rendering `ui` bare inside the router — a page that reads route
 * params via `useParams` (Roster's `:month`, PublicSchedule's `:token`) only has them populated
 * when actually rendered through a matching `<Route>`, not just anywhere inside a
 * `<MemoryRouter>`. */
export function renderWithProviders(
  ui: ReactElement,
  options: { initialEntries?: string[]; path?: string } = {},
): RenderResult & { store: ReturnType<typeof createAppStore> } {
  const store = createAppStore();
  const utils = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={options.initialEntries ?? ['/']}>
        <Routes>
          <Route path={options.path ?? '*'} element={ui} />
          {/* Swallows in-test navigation to routes the test doesn't otherwise care about (e.g. a
           * "Go to Roster" link's target) so it doesn't log React Router's "No routes matched"
           * warning — the test only asserts the link/button exists and is clickable, not that the
           * destination page renders. */}
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
  return { store, ...utils };
}
