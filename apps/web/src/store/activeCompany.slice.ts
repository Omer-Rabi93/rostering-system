import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { RootState } from './index.js';

/**
 * `localStorage` key the active company id is persisted under. This is the first place this
 * codebase touches `localStorage` (`grep -rn localStorage apps/ packages/` was empty before this
 * slice) — kept as one small, private constant here rather than a shared "storage" module, since
 * nothing else needs it yet.
 */
const STORAGE_KEY = 'rostering.activeCompanyId';

/**
 * Reads the persisted active-company id, if any. Never throws: a missing key, a value that isn't
 * valid JSON, or a value that doesn't parse down to a positive integer are all treated the same
 * way — "nothing persisted" — since a corrupt/stale `localStorage` entry (hand-edited, written by
 * a future/older version of this app, or simply cleared mid-session) must never crash the app on
 * load. Also swallows `localStorage` itself being unavailable (private browsing, disabled
 * storage) for the same reason.
 */
export function readPersistedCompanyId(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(JSON.parse(raw));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes (or, for `null`, clears) the persisted active-company id. Never throws, for the same
 * reasons as {@link readPersistedCompanyId} — a quota error or disabled storage should just mean
 * this session's selection doesn't survive a reload, not a crash.
 */
export function writePersistedCompanyId(id: number | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(id));
    }
  } catch {
    // Persistence is a nice-to-have (survives reloads) -- not required for the app to function
    // within this session, so a write failure here is silently ignored.
  }
}

/**
 * Client-only UI state tracking which company the planner is currently working in — the app's
 * single "active company" concept, replacing what used to be three independent per-page
 * `<Select>`s (Roster / Requirements / Cost Dashboard, each with its own local `useState`, no
 * shared state, and no persistence). Holds only the selected company's id, never a copy of the
 * company's own data (name, worker count, ...), which stays exclusively in the `Company` RTK
 * Query cache (`api/companies.api.ts`) — this slice is only ever used to look up an id, never
 * rendered directly.
 *
 * Persisted to `localStorage` (see the read/write helpers above) so the selection survives a
 * reload — initial state is read once, at module load, rather than lazily inside the reducer, to
 * match `createSlice`'s usual synchronous-initial-state shape. `apps/web/src/store/index.ts` is
 * responsible for the other half of persistence: a `store.subscribe` write-back whenever this
 * slice's value actually changes.
 *
 * This slice does NOT decide whether the persisted id still refers to a real company — a company
 * can be deleted (or `localStorage` can be stale/corrupt) out from under it. That validation
 * happens once, where the live company list is actually available:
 * `components/ActiveCompanyGate.tsx`, via `useListCompaniesQuery()`.
 */
export interface ActiveCompanyState {
  readonly activeCompanyId: number | null;
}

const initialState: ActiveCompanyState = {
  activeCompanyId: readPersistedCompanyId(),
};

const activeCompanySlice = createSlice({
  name: 'activeCompany',
  initialState,
  reducers: {
    companySelected(state, action: PayloadAction<number>) {
      state.activeCompanyId = action.payload;
    },
    companyCleared(state) {
      state.activeCompanyId = null;
    },
  },
});

export const { companySelected, companyCleared } = activeCompanySlice.actions;

export const activeCompanyReducer = activeCompanySlice.reducer;

export const selectActiveCompanyId = (state: RootState): number | null => state.activeCompany.activeCompanyId;
