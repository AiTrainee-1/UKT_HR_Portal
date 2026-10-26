import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  EmployeeRules,
  PayCycle,
  PayrollIssue,
  PeriodEmployee,
  ProductionCyclesSummary,
  ProductionPayrollItem,
  ProductionPeriodStatus,
  ProductionPeriods,
  ProductionSkipCheck,
  SalarySlipItem,
} from "@/lib/api-client/custom-hooks";
import {
  TODAY,
  WEEK,
  WEEKLY_PEOPLE,
  WEEKLY_RULES,
  WEEKLY_SLIPS,
  ASHA_ISSUES,
  cyclesOf,
  issuesResponse,
  periodsOf,
  rulesResponse,
  skipCheckOf,
  statementOf,
} from "./fixtures";
import ProductionCyclePage from "./ProductionCyclePage";

// Shared by the render tests of the Production Payroll pages: a fake server behind `customFetch`, a page mounted at a
// real address, and the small DOM helpers the other render tests of the repo use. (The `vi.mock` calls stay in each test
// file: vitest only hoists them there.)

export type World = {
  cycles: ProductionCyclesSummary;
  /** The roster of the Weekly cycle; a person's payslip belongs to WEEK, so any other period has none yet. */
  people: PeriodEmployee[];
  issues: PayrollIssue[];
  rules: EmployeeRules[];
  slips: SalarySlipItem[];
  settings: Record<string, unknown>;
  /** What /api/pf-esi-settings answers (the PF / ESI rules the Generate dialog and the Rules view count). */
  pfEsi: Record<string, unknown>;
  departments: { id: number; name: string }[];
  skipCheck: ProductionSkipCheck;
  /** What the server says today is (YYYY-MM-DD): a period ends once its last day is not after it. */
  today: string;
  /** Paths (without the query) that fail with this HTTP status. */
  failing: Map<string, number>;
  /** Answers for this path only once the returned function is called (a request that is still on its way). */
  hold: (path: string) => () => void;
  /** Every request made, as it was asked ("/api/payroll/production/issues?cycle=weekly&..."), and every body written. */
  requests: () => string[];
  writes: { method: string; url: string; body: Record<string, unknown> }[];
  /** Requests nobody planned for: a test that sees one has found a page asking for something it should not. */
  unexpected: string[];
};

export const apiError = (status: number): ApiError =>
  new ApiError(new Response(null, { status, statusText: String(status) }), null, { method: "GET", url: "/x" });

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The Monday-to-Sunday week holding a day (the Weekly cycle with Monday weeks). */
function weekHolding(date: string): { periodStart: string; periodEnd: string } {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const start = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 6);
  return { periodStart: start, periodEnd: d.toISOString().slice(0, 10) };
}

const payrollsOf = (people: PeriodEmployee[]): ProductionPayrollItem[] =>
  people.flatMap((p) => (p.payroll ? [p.payroll as ProductionPayrollItem] : []));

/** The Weekly cycle of February 2026, behind `fetchMock`. Everything a test changes is a field of the returned world. */
export function installWorld(fetchMock: Mock, over: Partial<World> = {}): World {
  const held = new Map<string, Promise<void>>();
  const requested: string[] = [];
  const world: World = {
    cycles: cyclesOf(),
    people: copy(WEEKLY_PEOPLE),
    issues: copy(ASHA_ISSUES),
    rules: copy(WEEKLY_RULES),
    slips: copy(WEEKLY_SLIPS),
    settings: {
      companyName: "UK Textiles Ltd",
      prodAttendanceMode: "strict",
      prodLateDetectionEnabled: true,
      prodLateFreeAllowance: 2,
      prodLateDeductionSlabs: [{ fromLates: 3, deductionShifts: 0.5 }],
      prodCycles: {
        weekly: {
          weekStart: "monday",
          anchorDate: null,
          lateFreeAllowance: 2,
          lateSlabs: [{ fromLates: 3, deductionShifts: 0.5 }],
          ownLateRules: false,
        },
      },
    },
    pfEsi: {
      scope: { branchId: null, branchName: null, isOverride: false },
      canEdit: true,
      staff: { pfRules: [], esiRules: [] },
      production: {
        pfRules: [{ id: "p1", label: "Below 25,000", basis: "total", minAmount: 0, maxAmount: 25000, ratePercent: 12 }],
        esiRules: [],
      },
      branches: [],
    },
    departments: [
      { id: 4, name: "Weaving" },
      { id: 5, name: "Stitching" },
    ],
    skipCheck: skipCheckOf(),
    today: TODAY,
    failing: new Map(),
    hold: (path) => {
      let release = () => {};
      held.set(
        path,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },
    requests: () => [...requested],
    writes: [],
    unexpected: [],
    ...over,
  };

  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    requested.push(url);
    const [path, query = ""] = url.split("?");
    const qs = new URLSearchParams(query);
    const method = (options?.method ?? "GET").toUpperCase();
    const gate = held.get(path);
    if (gate) await gate;
    const failure = world.failing.get(path);
    if (failure) throw apiError(failure);

    const period = {
      periodStart: qs.get("periodStart") ?? WEEK.periodStart,
      periodEnd: qs.get("periodEnd") ?? WEEK.periodEnd,
    };
    const inPeriod = (p: ProductionPayrollItem) =>
      p.periodStart === period.periodStart && p.periodEnd === period.periodEnd;
    const payrolls = payrollsOf(world.people);

    if (method === "PATCH") {
      const m = /^\/api\/payroll\/(\d+)$/.exec(path);
      const target = m ? payrolls.find((p) => p.id === Number(m[1])) : undefined;
      if (!target) {
        world.unexpected.push(`${method} ${url}`);
        throw apiError(404);
      }
      const body = JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>;
      world.writes.push({ method, url, body });
      Object.assign(target, body);
      target.finalSalary = target.grossSalary + target.bonus - target.deductions;
      return copy(target);
    }

    switch (path) {
      case "/api/payroll/production/cycles":
        return copy(world.cycles);
      case "/api/payroll/production/periods": {
        const roster = world.people.length;
        const list: ProductionPeriods = periodsOf((qs.get("cycle") ?? "weekly") as PayCycle, roster);
        const around = qs.get("around");
        if (around) {
          const holding = weekHolding(around);
          if (!list.periods.some((p) => p.periodStart === holding.periodStart)) {
            list.periods.push({
              ...holding,
              periodEnded: holding.periodEnd <= world.today,
              isNext: false,
              generated: 0,
              paid: 0,
            });
            list.periods.sort((a, b) => b.periodStart.localeCompare(a.periodStart));
          }
        }
        return copy(list);
      }
      case "/api/payroll/production/period-status": {
        const employees = world.people.map((p) => {
          const own = p.payroll && inPeriod(p.payroll as ProductionPayrollItem) ? p.payroll : null;
          return { ...p, payroll: own, blockedReason: own ? null : p.blockedReason };
        });
        const counts = { generated: 0, paid: 0, ready: 0, blocked: 0 };
        for (const e of employees) {
          if (e.payroll) counts[e.payroll.status === "paid" ? "paid" : "generated"] += 1;
          else counts[e.blockedReason ? "blocked" : "ready"] += 1;
        }
        const status: ProductionPeriodStatus = {
          cycle: (qs.get("cycle") ?? "weekly") as PayCycle,
          label: "Weekly",
          ...period,
          periodEnded: period.periodEnd <= world.today,
          counts,
          employees,
        };
        return copy(status);
      }
      case "/api/payroll/production":
        return copy(payrolls.filter((p) => (qs.get("periodStart") ? inPeriod(p) : true)));
      case "/api/payroll/production/issues": {
        const ids = new Set(payrolls.filter(inPeriod).map((p) => p.id));
        const issues = world.issues.filter((i) => i.payrollId !== null && ids.has(i.payrollId));
        return copy(issuesResponse(issues, ids.size, period));
      }
      case "/api/payroll/production/rules":
        return copy(rulesResponse(world.rules, period));
      case "/api/payroll/production/salary-statement":
        return copy(statementOf(payrolls.filter(inPeriod), period));
      case "/api/payroll/production/skip-check":
        return copy(world.skipCheck);
      case "/api/payroll-settings":
        return copy(world.settings);
      case "/api/pf-esi-settings":
        return copy(world.pfEsi);
      case "/api/departments":
        return copy(world.departments);
      case "/api/branches":
        // the statement's Branch select reads it; one branch means there is nothing to choose, so it stays out of the way
        return [{ id: 1, name: "Head Office" }];
      case "/api/salary-slips": {
        const month = Number(qs.get("month"));
        const year = Number(qs.get("year"));
        const cycle = qs.get("payCycle");
        return copy(
          world.slips.filter(
            (s) => s.month === month && s.year === year && (!cycle || (s.payCycle as string | null) === cycle),
          ),
        );
      }
      default:
        world.unexpected.push(`${method} ${url}`);
        throw new Error(`unexpected request ${method} ${url}`);
    }
  });
  return world;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Opens `url` (the address bar, and the history state a list page would have left) and renders one cycle's page. */
export function mountPage(url: string, cycle: PayCycle = "weekly", state: unknown = null) {
  window.history.replaceState(state, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(createElement(QueryClientProvider, { client }, createElement(ProductionCyclePage, { cycle }))),
  );
  return { client, host };
}

export function unmountPage() {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
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
export const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
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

/** A tab of the page (the tab row draws each label twice, so the role is the handle). */
export const tab = (name: string): HTMLElement =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t).startsWith(name))!;

export const here = () => `${window.location.pathname}${window.location.search}`;
export const params = () => Object.fromEntries(new URLSearchParams(window.location.search));

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
