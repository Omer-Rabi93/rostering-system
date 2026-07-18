import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { RootState } from './index.js';

/**
 * Client-only UI state tracking which modal/dialog (if any) is currently open across the app —
 * a single source of truth so at most one dialog is open at a time, and so the trigger-return-
 * focus contract (`packages/ui`'s `Modal`) has one well-known place to read "what's open" from.
 * Holds only the dialog's *kind* and whatever small identifying payload it needs to render (an id,
 * a month) — never a copy of server data (the dialog's actual content, e.g. a worker record or a
 * 409 warning list, is read fresh from the relevant RTK Query cache / mutation error at render
 * time by the Phase 9 page that owns it).
 */
export type DialogDescriptor =
  | { readonly kind: 'workerForm'; readonly workerId?: number }
  | { readonly kind: 'companyForm'; readonly companyId?: number }
  | { readonly kind: 'deactivateWorkerConfirm'; readonly workerId: number }
  | { readonly kind: 'shareLinkModal'; readonly workerId: number }
  | { readonly kind: 'deleteCompanyBlocked'; readonly companyId: number }
  | { readonly kind: 'deleteCompanyConfirm'; readonly companyId: number }
  | { readonly kind: 'rosterEditDialog'; readonly shiftId: number }
  | { readonly kind: 'softWarningConfirm' }
  | { readonly kind: 'hardBlockNotice' }
  | { readonly kind: 'regeneratePublishedConfirm'; readonly month: string }
  | { readonly kind: 'csvImportConfirm' }
  | { readonly kind: 'csvImportInProgressConfirm' }
  | { readonly kind: 'csvImportResult'; readonly jobId: string }
  | { readonly kind: 'availabilityCsvImportConfirm' }
  | { readonly kind: 'availabilityCsvImportInProgressConfirm' }
  | { readonly kind: 'availabilityCsvImportResult'; readonly jobId: string };

export interface DialogsState {
  readonly active: DialogDescriptor | null;
}

const initialState: DialogsState = {
  active: null,
};

const dialogsSlice = createSlice({
  name: 'dialogs',
  initialState,
  reducers: {
    dialogOpened(state, action: PayloadAction<DialogDescriptor>) {
      state.active = action.payload;
    },
    dialogClosed(state) {
      state.active = null;
    },
  },
});

export const { dialogOpened, dialogClosed } = dialogsSlice.actions;

export const dialogsReducer = dialogsSlice.reducer;

export const selectActiveDialog = (state: RootState): DialogDescriptor | null => state.dialogs.active;

export const selectIsDialogOpen =
  (kind: DialogDescriptor['kind']) =>
  (state: RootState): boolean =>
    state.dialogs.active?.kind === kind;
