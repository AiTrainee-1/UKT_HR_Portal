import type { OutpassRequestItem, PaginatedRecords } from "@/lib/api-client/custom-hooks";
import { ApiError } from "@/lib/api-client/custom-fetch";

// What the render-test fake server is made of, apart from the server itself (harness.tsx): the world of a test, the shape
// of a part's handler (harness-gates.ts, harness-inout.ts, harness-visitors.ts, harness-tea.ts) and the helpers those use.
// A file of its own so the parts import it without importing harness.tsx (which imports them).

/** The frozen clock of every render test: 14 October 2026, 11:30 in India (a Wednesday). */
export const NOW = "2026-10-14T06:00:00Z";

export type Call = { method: string; url: string; body: Record<string, unknown> };

export type World = {
  requests: OutpassRequestItem[];
  rule: { allowedMinutes: number; updatedAt: string };
  calls: Call[];
  /** Every `GET` of the page's lists, by path with its query string, in order. */
  gets: string[];
  unexpected: string[];
  /** Each part's own data (its gates, visits, breaks ...), under a key of its own: see `sliceState`. Fresh for every test. */
  state: Record<string, unknown>;
};

/**
 * One part's fake server: the request (method, path without the query, the query, the JSON body: {} for a GET) and the
 * world of the test. Return the response body, or undefined when the request is not this part's. To answer with an error
 * status, throw `harnessError(409, {...})`. Keep the part's own data in `world.state` (see `sliceState`).
 */
export type SliceHandler = (
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  world: World,
) => unknown;

export const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A part's own data in this test's world, made by `init` the first time it is asked for. */
export function sliceState<T>(world: World, key: string, init: () => T): T {
  if (!(key in world.state)) world.state[key] = init();
  return world.state[key] as T;
}

/** One page of `items` as the API pages them (`page` and `pageSize` from the query; 20 a page by default). */
export function paginate<T>(items: readonly T[], query: URLSearchParams, defaultSize = 20): PaginatedRecords<T> {
  const size = Math.max(1, Number(query.get("pageSize")) || defaultSize);
  const at = Math.max(1, Number(query.get("page")) || 1);
  return { items: copy(items.slice((at - 1) * size, at * size)), total: items.length, page: at, pageSize: size };
}

/** What a part throws to answer with an error status: the same ApiError customFetch throws for a real one. */
export function harnessError(status: number, data: unknown, method = "GET", url = "/api/"): ApiError {
  return new ApiError(new Response(null, { status }), data, { method, url });
}
