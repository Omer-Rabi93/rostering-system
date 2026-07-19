import { describe, expect, it } from 'vitest';

import { dialogClosed, dialogOpened, dialogsReducer, selectActiveDialog, selectIsDialogOpen } from '../../src/store/dialogs.slice.js';
import type { RootState } from '../../src/store/index.js';

describe('dialogs slice', () => {
  it('starts with no dialog open', () => {
    const state = dialogsReducer(undefined, { type: '@@INIT' });
    expect(state.active).toBeNull();
  });

  it('dialogOpened sets the active dialog descriptor', () => {
    const state = dialogsReducer(undefined, dialogOpened({ kind: 'workerForm', workerId: 5 }));
    expect(selectActiveDialog({ dialogs: state } as RootState)).toEqual({ kind: 'workerForm', workerId: 5 });
  });

  it('dialogClosed clears the active dialog', () => {
    const opened = dialogsReducer(undefined, dialogOpened({ kind: 'workforceCsvImportConfirm' }));
    const closed = dialogsReducer(opened, dialogClosed());
    expect(selectActiveDialog({ dialogs: closed } as RootState)).toBeNull();
  });

  it('opening a second dialog replaces the first (only one dialog open at a time)', () => {
    let state = dialogsReducer(undefined, dialogOpened({ kind: 'companyForm' }));
    state = dialogsReducer(state, dialogOpened({ kind: 'deleteCompanyBlocked', companyId: 9 }));
    expect(selectActiveDialog({ dialogs: state } as RootState)).toEqual({
      kind: 'deleteCompanyBlocked',
      companyId: 9,
    });
  });

  it('selectIsDialogOpen matches by kind', () => {
    const state = dialogsReducer(undefined, dialogOpened({ kind: 'softWarningConfirm' }));
    expect(selectIsDialogOpen('softWarningConfirm')({ dialogs: state } as RootState)).toBe(true);
    expect(selectIsDialogOpen('hardBlockNotice')({ dialogs: state } as RootState)).toBe(false);
  });
});
