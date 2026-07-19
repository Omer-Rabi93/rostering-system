import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// `vitest.config.ts` doesn't set `test.globals: true`, so Testing Library's
// framework auto-detection (which relies on a global `afterEach`) never
// fires. Without this, each render() leaks its DOM into the next test.
afterEach(() => {
  cleanup();
});

/**
 * `@tanstack/react-virtual` (windowing `Table`'s rows when `virtualized` -- see `Table/Table.tsx`)
 * test-environment shims. jsdom performs no real layout, so every element's
 * `offsetHeight`/`offsetWidth`/`clientHeight`/`clientWidth`/`scrollHeight`/`scrollWidth` are
 * hardwired to `0`, and `Element.prototype.scrollTo` is a documented no-op that never updates
 * `scrollTop` or fires a `scroll` event -- left alone, the virtualizer's size/offset math
 * degenerates (a `0` viewport renders nothing; `0`-height rows all land at the same offset, so it
 * renders everything). No other test in this workspace reads these properties (confirmed via a
 * repo-wide grep before adding this), so hardwiring them to small-but-nonzero constants here is
 * additive only. See `apps/web/vitest.setup.ts`'s identical block for the full reasoning.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
}

for (const prop of ['offsetHeight', 'clientHeight'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 40 });
}
for (const prop of ['offsetWidth', 'clientWidth'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 120 });
}
for (const prop of ['scrollHeight', 'scrollWidth'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 10_000_000 });
}

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
