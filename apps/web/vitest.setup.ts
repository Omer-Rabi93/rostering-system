import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import '@testing-library/jest-dom/vitest';

// Testing Library's auto-cleanup only self-registers when the test runner exposes a global
// `afterEach` (Vitest's `test.globals: true`), which this workspace's `vite.config.ts` does not
// enable. Without this, DOM from one test leaks into the next (queries like `getByText` start
// matching duplicate nodes across tests in the same file).
afterEach(() => {
  cleanup();
});

/**
 * Under the `jsdom` test environment, `AbortController`/`AbortSignal` are jsdom's own
 * webidl2js-generated implementations, while Node's built-in `fetch`/`Request` (which RTK
 * Query's `fetchBaseQuery` always calls `new Request(url, { signal, ... })` against) validate
 * `signal` with an `instanceof` check against Node's *own* internal `AbortSignal` reference —
 * captured once, at Node's undici module load time, before jsdom's environment substitutes
 * `globalThis.AbortSignal`. The two classes are unrelated even though both are named
 * `AbortSignal`, so real `fetchBaseQuery` calls throw `TypeError: RequestInit: Expected signal
 * ... to be an instance of AbortSignal` in every `apps/web` test that dispatches an RTK Query
 * endpoint under jsdom (regardless of whether `fetch` itself is mocked, since the throw happens
 * during `new Request(...)`, before the mocked `fetch`/`fetchFn` is ever called).
 *
 * `Request` construction happens unconditionally inside `fetchBaseQuery` before it hands off to
 * `fetchFn`, so tests that mock `fetch`/`fetchFn` still need a `Request` implementation that
 * doesn't perform that strict, environment-mismatched validation. This stand-in skips validation
 * entirely, side-stepping the jsdom/undici mismatch instead of trying to reconcile two unrelated
 * `AbortSignal` classes.
 *
 * `fetchFn` (see `api/baseApi.ts`) is always called with this single `Request`-like object as its
 * only argument (never a separate `(url, init)` pair) — a page-level mock needs `method`/`body`
 * off of it to distinguish e.g. `POST /api/companies` from `GET /api/companies`, so — unlike
 * `signal`, which is only read for real `AbortController` wiring — those are captured too.
 */
class TestRequestStub {
  readonly url: string;
  readonly method: string;
  readonly body?: BodyInit | null;
  readonly signal?: AbortSignal;
  constructor(input: string | URL, init: RequestInit = {}) {
    this.url = String(input);
    this.method = init.method ?? 'GET';
    if (init.body !== undefined) this.body = init.body;
    if (init.signal) this.signal = init.signal;
  }
}
vi.stubGlobal('Request', TestRequestStub);
