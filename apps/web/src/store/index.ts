import { configureStore } from '@reduxjs/toolkit';

import { baseApi } from '../api/baseApi.js';
import { ackChecklistReducer } from './ackChecklist.slice.js';
import { activeCompanyReducer, selectActiveCompanyId, writePersistedCompanyId, type ActiveCompanyState } from './activeCompany.slice.js';
import { dialogsReducer } from './dialogs.slice.js';
import { rosterEditorReducer } from './rosterEditor.slice.js';

/** Optional partial preloaded state a caller can seed a fresh store with — currently only
 * `activeCompany` needs this (tests that want to start already "inside" the gate, without going
 * through `localStorage`/a real pick flow). Kept narrow (not `Partial<RootState>`) since the
 * other slices/`baseApi` have no test-seeding need today; widen this if/when one does. */
export interface AppStorePreloadedState {
  readonly activeCompany?: ActiveCompanyState;
}

/** Factory (rather than a single top-level `configureStore` call) so tests can build an
 * independent store per test — sharing the module-level `store` singleton across tests would leak
 * RTK Query cache entries between them, since the cache lives inside the store itself. `main.tsx`
 * uses the `store` singleton below; `src/testUtils/renderWithProviders.tsx` uses this factory. */
export function createAppStore(preloadedState?: AppStorePreloadedState) {
  return configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
      rosterEditor: rosterEditorReducer,
      ackChecklist: ackChecklistReducer,
      dialogs: dialogsReducer,
      activeCompany: activeCompanyReducer,
    },
    preloadedState,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

export const store = createAppStore();

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Persistence write-back for the active-company selection (see `activeCompany.slice.ts`'s doc
// comment — this is the other half of the "survives a reload" contract). Subscribed once, here,
// against the app's real `store` singleton only — `createAppStore()`'s test-facing factory output
// deliberately does NOT get this subscription, so a test that dispatches `companySelected` never
// writes through to the real (jsdom, but shared-per-file) `localStorage` as a side effect.
// Tracks the last-written value so unrelated store updates (a roster refetch, a dialog opening,
// ...) don't cause a redundant `localStorage.setItem`/`removeItem` call on every dispatch.
let lastPersistedCompanyId = selectActiveCompanyId(store.getState());
store.subscribe(() => {
  const current = selectActiveCompanyId(store.getState());
  if (current !== lastPersistedCompanyId) {
    lastPersistedCompanyId = current;
    writePersistedCompanyId(current);
  }
});
