import type { ReactElement, ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Select } from '@rostering/ui';

import { useListCompaniesQuery } from '../api/companies.api.js';
import { currentMonth } from '../lib/calendar.js';
import { companySelected, selectActiveCompanyId } from '../store/activeCompany.slice.js';
import { useAppDispatch, useAppSelector } from '../store/hooks.js';
import { ActiveCompanyGate } from './ActiveCompanyGate.js';

/**
 * Authenticated app shell: topbar + primary nav, matching `docs/design/ui/kit.css`'s
 * `.topbar`/`.page` chrome (byte-for-byte reused via `@rostering/ui/styles.css`). Every
 * authenticated page (Workers, Companies, Roster, Cost Dashboard) renders inside this shell,
 * gated behind `ActiveCompanyGate` (see its own doc comment) so no page ever renders without a
 * valid active company. Staffing requirements are edited as part of the Companies create/edit
 * form (`CompanyFormModal`) rather than as their own nav destination. The public schedule page
 * deliberately does NOT use this component — see `pages/PublicSchedule/PublicSchedulePage.tsx`
 * and `docs/design/ui/README.md`'s "no authenticated chrome on an unauthenticated page" rule.
 */
export function Layout({ children }: { children: ReactNode }): ReactElement {
  const month = currentMonth();

  // The top-bar switcher needs its own "is the active company actually valid" check (same shape
  // as `ActiveCompanyGate`'s), since it lives in the topbar -- a sibling of the gate's own
  // `<main>` subtree, not a descendant of the `ActiveCompanyContext.Provider` the gate renders
  // only around `{children}`. Only shown once a company is actually active; the gate screen
  // (zero companies / picker) has its own picker UI and shouldn't also show this.
  const { data: companies } = useListCompaniesQuery();
  const activeCompanyId = useAppSelector(selectActiveCompanyId);
  const dispatch = useAppDispatch();
  const activeCompany = companies?.find((c) => c.id === activeCompanyId);

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
              <NavLink to={`/roster/${month}`}>Roster</NavLink>
            </li>
            <li>
              <NavLink to={`/cost/${month}`}>Cost Dashboard</NavLink>
            </li>
          </ul>
        </nav>
        {activeCompany ? (
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label visually-hidden" htmlFor="active-company-switcher">
              Active company
            </label>
            <Select
              id="active-company-switcher"
              value={String(activeCompany.id)}
              options={(companies ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
              onChange={(e) => dispatch(companySelected(Number(e.target.value)))}
            />
          </div>
        ) : null}
      </header>
      {/* No `.page` class here — every page component already renders its own top-level
       * `<div className="page">` (matching the mockups' `<main id="main" class="page">` being the
       * single page-content wrapper), so `<main>` here is just the landmark, not a second
       * `.page`-styled box around it. */}
      <main id="main">
        <ActiveCompanyGate>{children}</ActiveCompanyGate>
      </main>
    </>
  );
}
