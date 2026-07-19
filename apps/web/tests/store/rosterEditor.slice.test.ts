import { describe, expect, it } from 'vitest';

import {
  editCleared,
  editStaged,
  rosterEditorReducer,
  selectFocusedSlot,
  selectPendingEdit,
  selectSelectedWorkerId,
  slotFocusCleared,
  slotFocused,
  workerSelected,
  workerSelectionCleared,
  type RosterEditorState,
} from '../../src/store/rosterEditor.slice.js';
import type { RootState } from '../../src/store/index.js';

function stateOf(rosterEditor: RosterEditorState): Pick<RootState, 'rosterEditor'> {
  return { rosterEditor };
}

describe('rosterEditor slice', () => {
  it('starts with no focused slot, no selected worker, and no pending edit', () => {
    const state = rosterEditorReducer(undefined, { type: '@@INIT' });
    expect(state).toEqual({ focusedSlot: null, selectedWorkerId: null, pendingEdit: null });
  });

  it('slotFocused sets the focused slot (roving-tabindex state lifted from CalendarGrid)', () => {
    const state = rosterEditorReducer(undefined, slotFocused({ date: '2026-08-12', shift: 'B' }));
    expect(selectFocusedSlot(stateOf(state) as RootState)).toEqual({ date: '2026-08-12', shift: 'B' });
  });

  it('slotFocusCleared clears the focused slot', () => {
    const focused = rosterEditorReducer(undefined, slotFocused({ date: '2026-08-12', shift: 'B' }));
    const cleared = rosterEditorReducer(focused, slotFocusCleared());
    expect(selectFocusedSlot(stateOf(cleared) as RootState)).toBeNull();
  });

  it('workerSelected / workerSelectionCleared track the manual-edit dialog worker picker', () => {
    const selected = rosterEditorReducer(undefined, workerSelected(7));
    expect(selectSelectedWorkerId(stateOf(selected) as RootState)).toBe(7);
    const cleared = rosterEditorReducer(selected, workerSelectionCleared());
    expect(selectSelectedWorkerId(stateOf(cleared) as RootState)).toBeNull();
  });

  it('editStaged / editCleared track a pending add/move/remove edit', () => {
    const staged = rosterEditorReducer(
      undefined,
      editStaged({ kind: 'move', shiftId: 1, workerId: 7, targetShiftId: 2 }),
    );
    expect(selectPendingEdit(stateOf(staged) as RootState)).toEqual({
      kind: 'move',
      shiftId: 1,
      workerId: 7,
      targetShiftId: 2,
    });
    const cleared = rosterEditorReducer(staged, editCleared());
    expect(selectPendingEdit(stateOf(cleared) as RootState)).toBeNull();
  });
});
