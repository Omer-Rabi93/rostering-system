import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { RootState } from './index.js';

/**
 * Client-only UI state for the Roster page's `AlertChecklist`: which alert-acknowledge
 * mutations are currently in flight, so the checklist can disable/spin the checkbox that was
 * just clicked. The *acknowledged* boolean itself is server state (`Alert.acknowledged`, part of
 * the `Roster` RTK Query cache entry returned by `GET /api/rosters/:month`) and is never
 * duplicated here — this slice only tracks the transient "is a request in flight for this alert
 * id" fact between the user's click and the mutation settling (at which point the `Roster` tag
 * invalidation refreshes the real acknowledged flag from the server).
 */
export interface AckChecklistState {
  readonly pendingAlertIds: readonly number[];
}

const initialState: AckChecklistState = {
  pendingAlertIds: [],
};

const ackChecklistSlice = createSlice({
  name: 'ackChecklist',
  initialState,
  reducers: {
    ackRequested(state, action: PayloadAction<number>) {
      if (!state.pendingAlertIds.includes(action.payload)) {
        state.pendingAlertIds = [...state.pendingAlertIds, action.payload];
      }
    },
    ackSettled(state, action: PayloadAction<number>) {
      state.pendingAlertIds = state.pendingAlertIds.filter((id) => id !== action.payload);
    },
  },
});

export const { ackRequested, ackSettled } = ackChecklistSlice.actions;

export const ackChecklistReducer = ackChecklistSlice.reducer;

export const selectIsAckPending =
  (alertId: number) =>
  (state: RootState): boolean =>
    state.ackChecklist.pendingAlertIds.includes(alertId);
