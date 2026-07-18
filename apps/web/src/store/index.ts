import { configureStore } from '@reduxjs/toolkit';

import { baseApi } from '../api/baseApi.js';
import { ackChecklistReducer } from './ackChecklist.slice.js';
import { dialogsReducer } from './dialogs.slice.js';
import { rosterEditorReducer } from './rosterEditor.slice.js';

/** Factory (rather than a single top-level `configureStore` call) so tests can build an
 * independent store per test — sharing the module-level `store` singleton across tests would leak
 * RTK Query cache entries between them, since the cache lives inside the store itself. `main.tsx`
 * uses the `store` singleton below; `src/testUtils/renderWithProviders.tsx` uses this factory. */
export function createAppStore() {
  return configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
      rosterEditor: rosterEditorReducer,
      ackChecklist: ackChecklistReducer,
      dialogs: dialogsReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

export const store = createAppStore();

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
