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

/**
 * `@tanstack/react-virtual` (windowing `AvailabilityGrid`'s worker rows, see
 * `pages/Roster/AvailabilityGrid.tsx`) test-environment shims.
 *
 * jsdom performs no real layout, so every element's `offsetHeight`/`offsetWidth`/`clientHeight`/
 * `clientWidth`/`scrollHeight`/`scrollWidth` are hardwired to `0`, and `Element.prototype.scrollTo`
 * is a documented no-op that never updates `scrollTop` or fires a `scroll` event. Left alone, that
 * makes the virtualizer's size/offset math degenerate two different ways: a `0` viewport size makes
 * it think nothing fits (renders nothing), while `0`-height rows all land at the same offset (so
 * "how many rows fit in the viewport" becomes "all of them" — the opposite failure). None of these
 * properties are read by any other test in this workspace (confirmed via a repo-wide grep before
 * adding this), so hardwiring them to small-but-nonzero constants here is additive only.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
}

// A single, small default readback for every element's size — both the scroll container's own
// "viewport" size and each measured row's size are read off the exact same properties
// (`@tanstack/virtual-core`'s `getRect` reads `offsetWidth`/`offsetHeight` for both), so one
// uniform value keeps the math consistent: a 40px viewport / 40px-tall rows still yields a
// small, non-degenerate rendered window (roughly `1 + 2*overscan` rows) regardless of how many
// total rows exist.
for (const prop of ['offsetHeight', 'clientHeight'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 40 });
}
for (const prop of ['offsetWidth', 'clientWidth'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 120 });
}
// Large enough that `scrollHeight - clientHeight` (the virtualizer's own max-scroll-offset clamp)
// never becomes the binding constraint for any row count/height this workspace's tests use.
for (const prop of ['scrollHeight', 'scrollWidth'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 10_000_000 });
}

// A stateful `scrollTop` (jsdom's own always reads back `0`) plus a `scrollTo` that writes it and
// dispatches the native `scroll` event `@tanstack/virtual-core`'s `observeElementOffset` listens
// for — without both, `virtualizer.scrollToIndex()` computes a target offset but nothing ever
// reports it back, so the virtualizer never actually renders the scrolled-to row.
const scrollTopByElement = new WeakMap<Element, number>();
Object.defineProperty(Element.prototype, 'scrollTop', {
  configurable: true,
  get(this: Element): number {
    return scrollTopByElement.get(this) ?? 0;
  },
  set(this: Element, value: number) {
    scrollTopByElement.set(this, value);
  },
});
Element.prototype.scrollTo = function scrollTo(this: Element, options?: ScrollToOptions | number): void {
  const top = typeof options === 'object' && options !== null ? options.top : undefined;
  if (typeof top === 'number') scrollTopByElement.set(this, top);
  this.dispatchEvent(new Event('scroll'));
};
