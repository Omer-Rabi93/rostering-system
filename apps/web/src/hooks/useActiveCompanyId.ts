import { createContext, useContext } from 'react';

/**
 * Carries the app's single "active company" id down to every authenticated page, once
 * `components/ActiveCompanyGate.tsx` has confirmed (against the live `useListCompaniesQuery()`
 * result, not just whatever's in the `activeCompany` Redux slice) that it refers to a real
 * company. `null` initial value only exists so this context has a default at all — no component
 * ever actually reads `null` off of it in practice, since only `ActiveCompanyGate`-wrapped
 * subtrees render pages (see `useActiveCompanyId` below).
 */
export const ActiveCompanyContext = createContext<number | null>(null);

/**
 * Returns the app's guaranteed non-null active company id. Every authenticated page reads its
 * company scope through this hook instead of re-deriving/defending against an absent company
 * itself (the per-page "companies loading" spinner and "no companies yet" empty state that used
 * to be copy-pasted into `RosterPage`/`CostDashboardPage` now live once, in
 * `ActiveCompanyGate`).
 *
 * Throws if called outside an `ActiveCompanyContext.Provider` — that should never happen in
 * practice, since `components/Layout.tsx` wraps every authenticated route's `{children}` in
 * `ActiveCompanyGate`, which is the only place that ever provides this context. A throw here means
 * a real programming error (a page rendered outside `Layout`), not a state calling code should
 * handle gracefully.
 */
export function useActiveCompanyId(): number {
  const companyId = useContext(ActiveCompanyContext);
  if (companyId === null) {
    throw new Error(
      'useActiveCompanyId() was called outside an ActiveCompanyContext.Provider -- every authenticated page ' +
        'must render inside ActiveCompanyGate (via Layout). This is a programming error, not a runtime state.',
    );
  }
  return companyId;
}
