import { BrowserRouter } from 'react-router-dom';

import { AppRoutes } from './routes.js';

/**
 * Root application component. `AppRoutes` (routes.tsx) wires every page (Workers, Companies,
 * Requirements, Roster, Cost Dashboard, Public Schedule) — the authenticated ones inside
 * `components/Layout.tsx`'s topbar/nav shell, the public schedule page on its own.
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
