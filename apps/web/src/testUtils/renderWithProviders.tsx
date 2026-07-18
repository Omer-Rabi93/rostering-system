import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ActiveCompanyContext } from '../hooks/useActiveCompanyId.js';
import { createAppStore, type AppStorePreloadedState } from '../store/index.js';

export interface RenderWithProvidersOptions {
  readonly initialEntries?: string[];
  readonly path?: string;
  /** Wraps `ui` in an `ActiveCompanyContext.Provider` supplying this id, standing in for what
   * `ActiveCompanyGate` would normally provide once it's confirmed a company is active — lets a
   * page-level test render a page that calls `useActiveCompanyId()` directly (`RosterPage`,
   * `RequirementsPage`, `CostDashboardPage`, ...) without also having to drive the gate itself
   * (that's `ActiveCompanyGate.test.tsx`'s job). Does NOT touch the store's own `activeCompany`
   * slice -- see `preloadedState` for that. */
  readonly activeCompanyId?: number;
  /** Seeds the fresh store's initial state (currently only `activeCompany` supports this — see
   * `AppStorePreloadedState`). Needed for tests that render through the real `ActiveCompanyGate`
   * (e.g. `Layout`/`App`/`AppRoutes`-level tests, or `CompaniesPage`'s "deleting the active
   * company clears it" case) rather than a bare page, where the gate itself reads the
   * `activeCompany` slice via `useAppSelector`, not this file's `activeCompanyId` option above. */
  readonly preloadedState?: AppStorePreloadedState;
}

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
  options: RenderWithProvidersOptions = {},
): RenderResult & { store: ReturnType<typeof createAppStore> } {
  const store = createAppStore(options.preloadedState);
  const wrappedUi =
    options.activeCompanyId !== undefined ? (
      <ActiveCompanyContext.Provider value={options.activeCompanyId}>{ui}</ActiveCompanyContext.Provider>
    ) : (
      ui
    );
  const utils = render(
    <Provider store={store}>
      <MemoryRouter initialEntries={options.initialEntries ?? ['/']}>
        <Routes>
          <Route path={options.path ?? '*'} element={wrappedUi} />
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
