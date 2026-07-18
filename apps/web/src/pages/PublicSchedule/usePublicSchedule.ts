import { useEffect, useRef, useState } from 'react';

/**
 * The scoped shape `GET /api/schedule/:token?month=YYYY-MM` actually returns (see
 * `apps/api/src/services/publicScheduleService.ts`'s `PublicScheduleDto`) — worker display name
 * and that worker's own shifts for one published month. Deliberately re-declared here rather than
 * imported from `api/rosters.api.ts` or anywhere else that pulls in `baseApi`: this whole page
 * must have zero import-graph reachability into the authenticated RTK Query store (see
 * `PublicSchedulePage.architecture.test.ts`).
 */
export interface PublicScheduleShift {
  readonly date: string;
  readonly shiftType: 'A' | 'B' | 'C';
}

export interface PublicSchedule {
  readonly name: string;
  readonly month: string;
  readonly shifts: readonly PublicScheduleShift[];
}

export type PublicScheduleState =
  | { readonly status: 'loading' }
  /** A successful fetch this session already proved the token valid — a later 404 for a
   * different month is unambiguously "not published", not "bad link" (see `NOT_FOUND_MESSAGE`'s
   * doc comment in `publicScheduleService.ts`: the server's 404 is intentionally identical for
   * both cases, so this distinction is inferred client-side from prior successful loads). */
  | { readonly status: 'loaded'; readonly schedule: PublicSchedule }
  | { readonly status: 'notPublished'; readonly workerName: string }
  | { readonly status: 'invalidToken' };

/**
 * Plain `fetch`-based data hook — no RTK Query, no Redux, no `baseApi`. This is the one page in
 * the app that must never share the authenticated store: the token URL has no login, so it must
 * not carry, reuse, or risk leaking any credentialed client state.
 */
export function usePublicSchedule(token: string, month: string): PublicScheduleState {
  const [state, setState] = useState<PublicScheduleState>({ status: 'loading' });
  const lastKnownName = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    fetch(`/api/schedule/${encodeURIComponent(token)}?month=${encodeURIComponent(month)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const schedule = (await res.json()) as PublicSchedule;
          lastKnownName.current = schedule.name;
          setState({ status: 'loaded', schedule });
          return;
        }
        if (lastKnownName.current) {
          setState({ status: 'notPublished', workerName: lastKnownName.current });
        } else {
          setState({ status: 'invalidToken' });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'invalidToken' });
      });

    return () => {
      cancelled = true;
    };
  }, [token, month]);

  return state;
}
