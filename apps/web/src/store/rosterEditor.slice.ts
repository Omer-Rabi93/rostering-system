import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ShiftType } from '@rostering/shared';

import type { RootState } from './index.js';

/**
 * Client-only UI state for the Roster calendar's manual-edit interaction: which slot the
 * `CalendarGrid`'s roving tabindex currently points at, which worker is selected in the
 * manual-edit dialog, and a pending (not-yet-submitted) edit description used to drive the
 * 409-confirm / 422-block flow. This slice holds ONLY ephemeral UI state — the actual roster data
 * (shifts, assignments, alerts) lives exclusively in the `Roster` RTK Query cache
 * (`api/rosters.api.ts`), never duplicated here.
 */
export interface RosterSlot {
  readonly date: string;
  readonly shift: ShiftType;
}

export type PendingEditKind = 'add' | 'move' | 'remove';

export interface PendingEdit {
  readonly kind: PendingEditKind;
  readonly shiftId: number;
  readonly workerId: number;
  readonly targetShiftId?: number;
}

export interface RosterEditorState {
  readonly focusedSlot: RosterSlot | null;
  readonly selectedWorkerId: number | null;
  readonly pendingEdit: PendingEdit | null;
}

const initialState: RosterEditorState = {
  focusedSlot: null,
  selectedWorkerId: null,
  pendingEdit: null,
};

const rosterEditorSlice = createSlice({
  name: 'rosterEditor',
  initialState,
  reducers: {
    slotFocused(state, action: PayloadAction<RosterSlot>) {
      state.focusedSlot = action.payload;
    },
    slotFocusCleared(state) {
      state.focusedSlot = null;
    },
    workerSelected(state, action: PayloadAction<number>) {
      state.selectedWorkerId = action.payload;
    },
    workerSelectionCleared(state) {
      state.selectedWorkerId = null;
    },
    editStaged(state, action: PayloadAction<PendingEdit>) {
      state.pendingEdit = action.payload;
    },
    editCleared(state) {
      state.pendingEdit = null;
    },
  },
});

export const { slotFocused, slotFocusCleared, workerSelected, workerSelectionCleared, editStaged, editCleared } =
  rosterEditorSlice.actions;

export const rosterEditorReducer = rosterEditorSlice.reducer;

export const selectFocusedSlot = (state: RootState): RosterSlot | null => state.rosterEditor.focusedSlot;
export const selectSelectedWorkerId = (state: RootState): number | null => state.rosterEditor.selectedWorkerId;
export const selectPendingEdit = (state: RootState): PendingEdit | null => state.rosterEditor.pendingEdit;
