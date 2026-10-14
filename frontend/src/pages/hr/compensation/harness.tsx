import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, type Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  BalanceDetail,
  BalanceRow,
  CompensationCreditRow,
  CompensationReport,
  CompensationSettings,
  CompensationWindow,
  HolidayWorkClaim,
  HolidayWorkEligibleResponse,
  OvertimeConfig,
  OvertimeRow,
} from "@/lib/api-client/custom-hooks";
import Compensation from "../Compensation";
import {
  BALANCES,
  BRANCHES,
  CLAIMS,
  CONFIG,
  CREDITS,
  CTC_ROWS,
  DEPARTMENTS,
  ELIGIBLE_SUNDAY,
  ELIGIBLE_WEEKDAY,
  LEDGERS,
  OT_CONFIG,
  OT_ROWS,
  SUNDAY,
  TODAY,
  WINDOWS,
  birthdaysOf,
  reportOf,
} from "./fixtures";

// Shared by the render tests of the Compensation page: a fake server behind `customFetch`, the page mounted at a real
// address, and the small DOM helpers the other render tests of the repo use. (The `vi.mock` calls stay in each test file:
// vitest only hoists them there.) The clock is October 14, 2026 (see `freezeClock`).

export type Call = { method: string; url: string; body: Record<string, unknown> };

export type World = {
  settings: { companyName: string; compensationFeatureEnabled: boolean };
  config: CompensationSettings;
  ot: OvertimeRow[];
  otConfig: OvertimeConfig;
  windows: CompensationWindow[];
  windowsEnabled: boolean;
  claims: HolidayWorkClaim[];
  holidayEnabled: { master: boolean; holidayWork: boolean; workflow: boolean; canRaise: boolean };
  eligible: Record<string, HolidayWorkEligibleResponse>;
  balances: BalanceRow[];
  ledgers: Record<number, BalanceDetail>;
  credits: CompensationCreditRow[];
  birthdayEnabled: boolean;
  report: (qs: URLSearchParams) => CompensationReport;
  departments: { id: number; name: string }[];
  branches: { id: number; name: string }[];
  /** Answers for a request, in place of the default: `method path` -> what to return (or throw). */
  on: Map<string, (call: Call, qs: URLSearchParams) => unknown>;
  /** Paths (without the query) that fail with this HTTP status. */
  failing: Map<string, { status: number; body?: unknown }>;
  /** Answers for this path only once the returned function is called (a request that is still on its way). */
  hold: (path: string) => () => void;
  /** Every request made, as it was asked. */
  requests: () => string[];
  /** Every change sent. */
  writes: Call[];
  /** Requests nobody planned for: a test that sees one has found a page asking for something it should not. */
  unexpected: string[];
};

export const apiError = (status: number, body: unknown = null): ApiError =>
  new ApiError(new Response(null, { status, statusText: String(status) }), body, { method: "GET", url: "/x" });

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The month of October 2026, behind `fetchMock`. Everything a test changes is a field of the returned world. */
export function installWorld(fetchMock: Mock, over: Partial<World> = {}): World {
  const held = new Map<string, Promise<void>>();
  const requested: string[] = [];
  const world: World = {
    settings: { companyName: "UK Textiles Ltd", compensationFeatureEnabled: true },
    config: copy(CONFIG),
    ot: copy(OT_ROWS),
    otConfig: { ...OT_CONFIG },
    windows: copy(WINDOWS),
    windowsEnabled: true,
    claims: copy(CLAIMS),
    holidayEnabled: { master: true, holidayWork: true, workflow: true, canRaise: true },
    eligible: { [SUNDAY]: copy(ELIGIBLE_SUNDAY), "2026-10-13": copy(ELIGIBLE_WEEKDAY) },
    balances: copy(BALANCES),
    ledgers: copy(LEDGERS),
    credits: copy(CREDITS),
    birthdayEnabled: true,
    report: (qs) => reportOf(qs),
    departments: DEPARTMENTS,
    branches: BRANCHES,
    on: new Map(),
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
    if (failure) throw apiError(failure.status, failure.body ?? null);

    const body = options?.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {};
    const call: Call = { method, url, body };
    if (method !== "GET") world.writes.push(call);
    const custom = world.on.get(`${method} ${path}`);
    if (custom) {
      const answer = custom(call, qs);
      if (answer instanceof Error) throw answer;
      return copy(answer);
    }

    const GET = method === "GET";
    switch (true) {
      case GET && path === "/api/payroll-settings":
        return copy(world.settings);
      case GET && path === "/api/compensation/config":
        return copy(world.config);
      case GET && path === "/api/departments":
        return copy(world.departments);
      case GET && path === "/api/branches":
        return copy(world.branches);
      case GET && path === "/api/compensation":
        return { results: copy(CTC_ROWS), count: CTC_ROWS.length };
      case GET && path === "/api/compensation/ot": {
        const inMonth = qs.get("month") === "10" && qs.get("year") === "2026";
        const results = inMonth ? world.ot : [];
        return copy({
          results,
          count: results.length,
          settings: { otDetectionEnabled: true, otThresholdMinutes: 150, otCompensationType: "pay" },
          config: world.otConfig,
        });
      }
      case method === "POST" && path === "/api/compensation/ot/assign": {
        // every record goes through, as the server would: assigned, with the shifts and the date it was given
        const results: OvertimeRow[] = [];
        for (const rec of (body.records ?? []) as {
          employeeId: number;
          date: string;
          shifts?: number;
          claimDate?: string;
        }[]) {
          const row = world.ot.find((r) => r.employeeId === rec.employeeId && r.date === rec.date);
          if (!row) continue;
          Object.assign(row, {
            status: "announced",
            statusLabel: "Assigned",
            canAssign: false,
            compensationType: body.mode,
            shifts: rec.shifts ?? row.suggestedShifts,
            claimDate: rec.claimDate ?? null,
            announcedBy: "Meena",
          });
          results.push(copy(row));
        }
        return { assigned: results.length, results, skipped: [] };
      }
      case method === "POST" && path === "/api/compensation/ot/reject": {
        let rejected = 0;
        for (const rec of (body.records ?? []) as { employeeId: number; date: string }[]) {
          const row = world.ot.find(
            (r) => r.employeeId === rec.employeeId && r.date === rec.date && r.status === "detected",
          );
          if (row) {
            row.status = "rejected";
            row.statusLabel = "Rejected";
            row.canAssign = false;
            rejected += 1;
          }
        }
        return { rejected };
      }
      case method === "POST" && path === "/api/compensation/ot/announce":
        return { announced: ((body.records ?? []) as unknown[]).length, results: [] };
      case GET && path === "/api/compensation/windows": {
        const results = world.windows;
        return copy({
          results,
          count: results.length,
          truncated: false,
          today: TODAY,
          enabled: { master: true, windows: world.windowsEnabled, canAnnounce: world.windowsEnabled },
        });
      }
      case method === "POST" && path === "/api/compensation/windows": {
        const made = {
          id: 950,
          date: body.date,
          kind: body.kind,
          kindLabel: body.kind === "late_in" ? "Late-in" : "Early-out",
          time: body.time,
          reason: body.reason,
          branchId: body.branchId ?? null,
          branch: null,
          departmentId: body.departmentId ?? null,
          department: null,
          employeeIds: [],
          employeeCount: 0,
          covers: 214,
          allStaff: true,
          announcedBy: "Meena",
          createdAt: "2026-10-14T06:00:00+00:00",
          canDelete: true,
        } as CompensationWindow;
        world.windows.unshift(made);
        return made;
      }
      case method === "DELETE" && /^\/api\/compensation\/windows\/\d+$/.test(path): {
        const id = Number(path.split("/").pop());
        world.windows = world.windows.filter((w) => w.id !== id);
        return null;
      }
      case GET && path === "/api/compensation/holiday-work": {
        const status = qs.get("status");
        const results = world.claims.filter((c) => !status || status === "all" || c.status === status);
        return copy({
          results,
          count: results.length,
          truncated: false,
          month: qs.get("anyMonth") ? null : Number(qs.get("month") ?? 10),
          year: qs.get("anyMonth") ? null : Number(qs.get("year") ?? 2026),
          summary: {
            pending: world.claims.filter((c) => c.status === "pending").length,
            approved: world.claims.filter((c) => c.status === "approved").length,
            rejected: world.claims.filter((c) => c.status === "rejected").length,
            approvedShifts: 1,
            pendingShifts: 0.5,
          },
          enabled: world.holidayEnabled,
        });
      }
      case method === "POST" && path === "/api/compensation/holiday-work": {
        // every claim goes through, as the server would: raised by HR and waiting for the Department Head
        const day = String(body.workDate);
        const people = world.eligible[day]?.employees ?? [];
        const made = ((body.items ?? []) as { employeeId: number; shifts: number }[]).map((item, i) => {
          const who = people.find((p) => p.employeeId === item.employeeId);
          return {
            ...copy(CLAIMS[0]),
            id: 3100 + i,
            employeeId: item.employeeId,
            employeeCode: who?.employeeCode ?? `E${item.employeeId}`,
            employeeName: who?.employeeName ?? `Employee ${item.employeeId}`,
            workDate: day,
            shifts: item.shifts,
            reason: String(body.reason),
          } as HolidayWorkClaim;
        });
        world.claims.unshift(...made);
        return { created: made.length, warnings: [], claims: made };
      }
      case GET && path === "/api/compensation/holiday-work/eligible": {
        const day = qs.get("date") ?? "";
        const found = world.eligible[day];
        if (!found) throw apiError(400, { error: "date must be a date (YYYY-MM-DD)." });
        return copy({ ...found, enabled: world.holidayEnabled });
      }
      case method === "DELETE" && /^\/api\/compensation\/holiday-work\/\d+$/.test(path): {
        const id = Number(path.split("/").pop());
        world.claims = world.claims.filter((c) => c.id !== id);
        return null;
      }
      case GET && path === "/api/compensation/balance": {
        const employeeId = qs.get("employeeId");
        if (employeeId) {
          const detail = world.ledgers[Number(employeeId)];
          if (!detail) throw apiError(404, { error: "Employee not found" });
          return copy(detail);
        }
        return { results: copy(world.balances), count: world.balances.length };
      }
      case GET && path === "/api/compensation/credits":
        return { results: copy(world.credits), count: world.credits.length };
      case GET && path === "/api/compensation/birthdays":
        return birthdaysOf((qs.get("period") ?? "today") as "today", qs.get("date") ?? TODAY, world.birthdayEnabled);
      case GET && path === "/api/compensation/reports":
        return copy(world.report(qs));
      default:
        world.unexpected.push(`${method} ${url}`);
        throw new Error(`unexpected request ${method} ${url}`);
    }
  });
  return world;
}

// ── mounting ──

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Opens `url` (the address bar) and renders the Compensation page. */
export function mountPage(url: string) {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Compensation))));
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

/** The clock: 14 October 2026, 11:30 in India (so `todayIst()` says 2026-10-14). Only Date is faked; timers stay real. */
export function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T06:00:00Z"));
}

// ── DOM helpers ──

export const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export const all = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
export const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
export const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 500)}`);
  return el;
};
export const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
export const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
export const typeInto = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
export const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Keeps the page turning (inside act) until `check` holds. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const started = Date.now();
  // Date is faked: count real time with performance.now
  const t0 = performance.now();
  void started;
  while (!check()) {
    if (performance.now() - t0 > timeoutMs)
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 400)}`);
    await settle(8);
  }
}

/** A tab of the page (the tab row draws each label twice, so the role is the handle). */
export const tab = (name: string): HTMLElement =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t).startsWith(name))!;

/** Picks an option of a Radix select: opens it from its trigger, clicks the option, in one go. */
export const pickOption = (trigger: HTMLElement, label: string | RegExp) => {
  press(trigger, "ArrowDown");
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
    typeof label === "string" ? text(o) === label : label.test(text(o)),
  );
  if (!option)
    throw new Error(
      `no option ${label}: ${[...document.body.querySelectorAll('[role="option"]')].map(text).join(" | ")}`,
    );
  click(option);
};

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

/** The request bodies of every change to this path. */
export const bodiesOf = (world: World, method: string, path: string): Record<string, unknown>[] =>
  world.writes.filter((w) => w.method === method && w.url.split("?")[0] === path).map((w) => w.body);
