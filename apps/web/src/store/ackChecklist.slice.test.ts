import { describe, expect, it } from 'vitest';

import { ackChecklistReducer, ackRequested, ackSettled, selectIsAckPending } from './ackChecklist.slice.js';
import type { RootState } from './index.js';

describe('ackChecklist slice', () => {
  it('starts with no pending acknowledgements', () => {
    const state = ackChecklistReducer(undefined, { type: '@@INIT' });
    expect(state.pendingAlertIds).toEqual([]);
  });

  it('ackRequested marks an alert id as pending', () => {
    const state = ackChecklistReducer(undefined, ackRequested(3));
    expect(selectIsAckPending(3)({ ackChecklist: state } as RootState)).toBe(true);
    expect(selectIsAckPending(4)({ ackChecklist: state } as RootState)).toBe(false);
  });

  it('ackRequested is idempotent for the same alert id', () => {
    let state = ackChecklistReducer(undefined, ackRequested(3));
    state = ackChecklistReducer(state, ackRequested(3));
    expect(state.pendingAlertIds).toEqual([3]);
  });

  it('ackSettled clears the pending flag once the mutation settles', () => {
    let state = ackChecklistReducer(undefined, ackRequested(3));
    state = ackChecklistReducer(state, ackSettled(3));
    expect(selectIsAckPending(3)({ ackChecklist: state } as RootState)).toBe(false);
  });
});
