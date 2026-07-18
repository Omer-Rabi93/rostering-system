import type { ReactElement, ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { currentMonth } from '../lib/calendar.js';

/**
 * Authenticated app shell: topbar + primary nav, matching `docs/design/ui/kit.css`'s
 * `.topbar`/`.page` chrome (byte-for-byte reused via `@rostering/ui/styles.css`). Every
 * authenticated page (Workers, Companies, Requirements, Roster, Cost Dashboard) renders inside
 * this shell. The public schedule page deliberately does NOT use this component — see
 * `pages/PublicSchedule/PublicSchedulePage.tsx` and `docs/design/ui/README.md`'s "no authenticated
 * chrome on an unauthenticated page" rule.
 */
export function Layout({ children }: { children: ReactNode }): ReactElement {
  const month = currentMonth();

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <span className="topbar__brand">ICTS Rostering</span>
        <nav aria-label="Primary">
          <ul className="topbar__nav">
            <li>
              <NavLink to="/workers">Workers</NavLink>
            </li>
            <li>
              <NavLink to="/companies">Companies</NavLink>
            </li>
            <li>
              <NavLink to="/requirements">Requirements</NavLink>
            </li>
            <li>
              <NavLink to={`/roster/${month}`}>Roster</NavLink>
            </li>
            <li>
              <NavLink to={`/cost/${month}`}>Cost Dashboard</NavLink>
            </li>
          </ul>
        </nav>
      </header>
      {/* No `.page` class here — every page component already renders its own top-level
       * `<div className="page">` (matching the mockups' `<main id="main" class="page">` being the
       * single page-content wrapper), so `<main>` here is just the landmark, not a second
       * `.page`-styled box around it. */}
      <main id="main">{children}</main>
    </>
  );
}
