import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route } from "wouter";
import type { Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { PayrollBreakdownResponse, PayrollDetails, PayrollKind } from "@/lib/api-client/custom-hooks";
import {
  CO_EMP_STATUTORY,
  NOT_CO_EMP_STATUTORY,
  TDS_STATUTORY,
  breakdownOf,
  cleanDetails,
  legacyDetails,
  noBreakdownDetails,
  noSlipDetails,
  productionDetails,
  staffDetails,
  tdsDetails,
} from "./fixtures";
import ProductionPayrollDetails from "./ProductionPayrollDetails";
import StaffPayrollDetails from "./StaffPayrollDetails";

// Shared by the render tests of the details page: a fake server behind `customFetch`, the page mounted under the real
// router at a real address, and the small DOM helpers the other render tests of the repo use. (The `vi.mock` calls
// stay in each test file: vitest only hoists them there.)

type Answer = PayrollDetails | Error;
type BreakdownAnswer = PayrollBreakdownResponse | Error;

export type World = {
  staff: Map<number, Answer>;
  production: Map<number, Answer>;
  /** What /api/payroll/<id>/breakdown answers (where PF / ESI / TDS were decided is stored); a missing id is a 404. */
  breakdowns: Map<number, BreakdownAnswer>;
  /** What /api/payroll-settings answers. */
  settings: { companyName: string };
  /** Answers for this payroll only once the returned function is called (a request that is still on its way). */
  hold: (kind: PayrollKind, id: number) => () => void;
  requests: () => string[];
};

export const apiError = (status: number): ApiError =>
  new ApiError(new Response(null, { status, statusText: String(status) }), null, { method: "GET", url: "/x" });

/**
 * Behind `fetchMock`: the staff payrolls 101 (October issues), 102 (clean), 103 (no payslip) and 105 (no breakdown), and
 * the production payrolls 301 (a week) and 304 (an older session-based one).
 */
export function installWorld(fetchMock: Mock): World {
  const held = new Map<string, Promise<void>>();
  const world: World = {
    staff: new Map<number, Answer>([
      [101, staffDetails()],
      [102, cleanDetails()],
      [103, noSlipDetails({ payrollId: 103, neighbours: { previousId: 102, nextId: null, position: 5, total: 42 } })],
      [105, noBreakdownDetails()],
      [106, tdsDetails()],
    ]),
    production: new Map<number, Answer>([
      [301, productionDetails()],
      [304, legacyDetails()],
    ]),
    breakdowns: new Map<number, BreakdownAnswer>([
      [101, breakdownOf(101, { pf: 1599.92, pfRate: 12, statutory: CO_EMP_STATUTORY })],
      [102, breakdownOf(102, { statutory: NOT_CO_EMP_STATUTORY })],
      // a payroll generated before the PF / ESI redesign: PF and ESI are stored, the `statutory` block is not
      [103, breakdownOf(103, { pf: 1599.92, pfRate: 12 })],
      [105, { ...breakdownOf(105, {}), breakdown: null }],
      [106, breakdownOf(106, { tds: 2950, tdsPercent: 10, statutory: TDS_STATUTORY })],
      [
        301,
        breakdownOf(301, { pf: 351, pfRate: 12, statutory: { ...CO_EMP_STATUTORY, rulesScope: "branch" } }, "shift"),
      ],
    ]),
    settings: { companyName: "UK Textiles Ltd" },
    hold: (kind, id) => {
      let release = () => {};
      held.set(
        `${kind}:${id}`,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },
    requests: () => fetchMock.mock.calls.map((c) => String(c[0])),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/payroll-settings") return world.settings;
    const stored = /^\/api\/payroll\/(\d+)\/breakdown$/.exec(url);
    if (stored) {
      const answer = world.breakdowns.get(Number(stored[1]));
      if (!answer) throw apiError(404);
      if (answer instanceof Error) throw answer;
      return JSON.parse(JSON.stringify(answer));
    }
    const m = /^\/api\/payroll(\/production)?\/(\d+)\/details$/.exec(url);
    if (!m) throw new Error(`unexpected request ${url}`);
    const kind: PayrollKind = m[1] ? "production" : "staff";
    const id = Number(m[2]);
    const gate = held.get(`${kind}:${id}`);
    if (gate) await gate;
    const answer = world[kind].get(id);
    if (!answer) throw apiError(404);
    if (answer instanceof Error) throw answer;
    return JSON.parse(JSON.stringify(answer));
  });
  return world;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Opens `url` (the address bar, and the history state a list page would have left) and renders both details routes. */
export function mountPage(url: string, state: unknown = null) {
  window.history.replaceState(state, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          "div",
          null,
          createElement(Route, { path: "/hr/payroll/details/:id" }, createElement(StaffPayrollDetails)),
          createElement(Route, { path: "/hr/production-payroll/details/:id" }, createElement(ProductionPayrollDetails)),
        ),
      ),
    ),
  );
  return { client, host };
}

export function unmountPage() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

export const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export const all = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
export const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
export const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 400)}`);
  return el;
};
export const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
export const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
export const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
export const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
export const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Keeps the page turning (inside act) until `check` holds. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 300)}`);
    await settle(8);
  }
}

/** Mounts a page and waits for its first payroll to be on screen. */
export async function openLoaded(url: string, state: unknown = null) {
  const mounted = mountPage(url, state);
  await waitFor(() => !!q("pd-body"), "the payroll to load");
  return mounted;
}

export const here = () => `${window.location.pathname}${window.location.search}`;

export function installBrowserStubs() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

/** The elements `scrollIntoView` was called on (a spy the test installed on the prototype). */
export const scrolledTo = (spy: Mock): string[] =>
  spy.mock.contexts.map((el) => (el as HTMLElement).id || (el as HTMLElement).dataset.ruleKey || "?");
