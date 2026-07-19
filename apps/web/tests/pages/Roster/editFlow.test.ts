import { describe, expect, it } from 'vitest';

import { initialEditFlowState, reduceEditFlow } from '../../../src/pages/Roster/editFlow.js';

describe('reduceEditFlow', () => {
  it('starts idle', () => {
    expect(initialEditFlowState).toEqual({ status: 'idle' });
  });

  it('submit -> submitting -> succeeded -> success', () => {
    let state = reduceEditFlow(initialEditFlowState, { type: 'submit' });
    expect(state).toEqual({ status: 'submitting' });

    state = reduceEditFlow(state, { type: 'succeeded' });
    expect(state).toEqual({ status: 'success' });
  });

  it('submit -> submitting -> hardBlocked (422) carries the violation messages, no override path', () => {
    let state = reduceEditFlow(initialEditFlowState, { type: 'submit' });
    state = reduceEditFlow(state, {
      type: 'hardBlocked',
      violations: ['Worker already has 2 shifts on 2026-08-06'],
    });

    expect(state).toEqual({
      status: 'blocked',
      violations: ['Worker already has 2 shifts on 2026-08-06'],
    });
  });

  it('a blocked notice is dismissed back to idle (no confirm/retry path for a hard block)', () => {
    const blocked = reduceEditFlow(
      { status: 'submitting' },
      { type: 'hardBlocked', violations: ['x'] },
    );
    expect(reduceEditFlow(blocked, { type: 'cancelled' })).toEqual({ status: 'idle' });
  });

  it('submit -> submitting -> confirmRequired (409) -> confirmAccepted resubmits (back to submitting)', () => {
    let state = reduceEditFlow(initialEditFlowState, { type: 'submit' });
    state = reduceEditFlow(state, {
      type: 'confirmRequired',
      warnings: ['Would exceed max monthly hours (190 > 186)'],
    });
    expect(state).toEqual({
      status: 'confirming',
      warnings: ['Would exceed max monthly hours (190 > 186)'],
    });

    state = reduceEditFlow(state, { type: 'confirmAccepted' });
    expect(state).toEqual({ status: 'submitting' });

    state = reduceEditFlow(state, { type: 'succeeded' });
    expect(state).toEqual({ status: 'success' });
  });

  it('confirming -> cancelled returns to idle WITHOUT ever reaching submitting again (no silent apply)', () => {
    const confirming = reduceEditFlow(
      { status: 'submitting' },
      { type: 'confirmRequired', warnings: ['x'] },
    );
    expect(reduceEditFlow(confirming, { type: 'cancelled' })).toEqual({ status: 'idle' });
  });

  it('reset always returns to idle from any state', () => {
    expect(reduceEditFlow({ status: 'success' }, { type: 'reset' })).toEqual({ status: 'idle' });
    expect(
      reduceEditFlow({ status: 'blocked', violations: [] }, { type: 'reset' }),
    ).toEqual({ status: 'idle' });
  });
});
