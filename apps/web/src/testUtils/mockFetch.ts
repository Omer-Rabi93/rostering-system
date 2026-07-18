import { vi } from 'vitest';

export interface MockRoute {
  readonly method: string;
  /** Matched against the request's full pathname (e.g. `/api/companies`, `/api/schedule/:token`)
   * — either an exact string or a RegExp. */
  readonly match: string | RegExp;
  readonly respond: (url: URL, init: RequestInit | undefined) => { status: number; body?: unknown; text?: string };
}

function matches(route: MockRoute, method: string, path: string): boolean {
  if (route.method.toUpperCase() !== method.toUpperCase()) return false;
  return typeof route.match === 'string' ? route.match === path : route.match.test(path);
}

/**
 * Installs a `vi.stubGlobal('fetch', ...)` mock that dispatches to whichever `MockRoute` matches
 * a request's method + path — lets a page test declare "GET /companies -> [...]" / "POST
 * /companies -> 409 {...}" once, in a table, instead of ordering brittle
 * `mockResolvedValueOnce` chains that break the moment an extra request is added. Returns the
 * underlying `vi.fn()` so a test can still assert on call counts/order if it needs to.
 *
 * `fetchBaseQuery` (see `api/baseApi.ts`) always calls its `fetchFn` with a single `Request`
 * object (never a separate `(url, init)` pair) — under the `jsdom` test environment that object
 * is `vitest.setup.ts`'s `TestRequestStub`, which carries `url`/`method`/`body`, so both the
 * single-argument real shape and a plain `(url, init)` call are handled here for robustness.
 */
export function installMockFetch(routes: MockRoute[]) {
  const calls: { method: string; path: string }[] = [];

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, 'http://localhost');
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as { method: string }).method : undefined) ?? 'GET';
    calls.push({ method, path: url.pathname + url.search });

    const route = routes.find((r) => matches(r, method, url.pathname));
    if (!route) {
      throw new Error(`No mock route for ${method} ${url.pathname}`);
    }
    const result = route.respond(url, init);
    // The Fetch spec (and jsdom's `Response` constructor) forbids a non-null body on a
    // null-body status (204 No Content, 205 Reset Content, 304 Not Modified) — a mocked 204 (e.g.
    // `DELETE /shifts/:id/workers/:workerId`'s real response shape) must pass `null`, not `''`.
    const NULL_BODY_STATUSES = new Set([204, 205, 304]);
    const body = NULL_BODY_STATUSES.has(result.status)
      ? null
      : (result.text ?? (result.body !== undefined ? JSON.stringify(result.body) : ''));
    return Promise.resolve(
      new Response(body, {
        status: result.status,
        headers: { 'Content-Type': result.text ? 'text/csv' : 'application/json' },
      }),
    );
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}
