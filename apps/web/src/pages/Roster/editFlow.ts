/**
 * Pure state machine for the roster manual-edit confirm flow (add/move/remove a worker on a
 * shift): every submit either succeeds, is hard-blocked (422, no override — `blocked`), or needs
 * a soft-warning confirm (409 `confirmRequired` — `confirming`, resubmit with `?confirm=true`).
 * Kept as a standalone reducer (independent of the actual RTK Query mutation call, which the page
 * wires in separately) so the confirm/block branching can be unit-tested directly instead of only
 * through a full component render.
 */
export type EditFlowState =
  | { readonly status: 'idle' }
  | { readonly status: 'submitting' }
  | { readonly status: 'blocked'; readonly violations: readonly string[] }
  | { readonly status: 'confirming'; readonly warnings: readonly string[] }
  | { readonly status: 'success' };

export type EditFlowEvent =
  | { readonly type: 'submit' }
  | { readonly type: 'hardBlocked'; readonly violations: readonly string[] }
  | { readonly type: 'confirmRequired'; readonly warnings: readonly string[] }
  | { readonly type: 'succeeded' }
  | { readonly type: 'confirmAccepted' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'reset' };

export const initialEditFlowState: EditFlowState = { status: 'idle' };

export function reduceEditFlow(state: EditFlowState, event: EditFlowEvent): EditFlowState {
  switch (event.type) {
    case 'submit':
      // A fresh submit is only valid from idle or after a resolved dialog (blocked notices are
      // dismissed before retrying, confirming resubmits via 'confirmAccepted' instead).
      return { status: 'submitting' };
    case 'hardBlocked':
      return { status: 'blocked', violations: event.violations };
    case 'confirmRequired':
      return { status: 'confirming', warnings: event.warnings };
    case 'succeeded':
      return { status: 'success' };
    case 'confirmAccepted':
      // "Save anyway" resubmits the identical request with confirm=true.
      return { status: 'submitting' };
    case 'cancelled':
      return { status: 'idle' };
    case 'reset':
      return { status: 'idle' };
    default:
      return state;
  }
}
