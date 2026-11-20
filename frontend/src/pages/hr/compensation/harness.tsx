import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, type Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  BalanceDetail,
  BalanceListRow,
  CompensationClaim,
  CompensationCreditRow,
  CompensationReport,
  CompensationSettings,
  CompensationWindow,
  HolidayWorkEligibleResponse,
  HolidayWorkEnabled,
  HolidayWorkMonthDay,
  LedgerRow,
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
  ELIGIBLE_FIRST_SUNDAY,
  ELIGIBLE_SUNDAY,
  ELIGIBLE_WEEKDAY,
  LEDGER,
  LEDGERS,
  MONTH_DAYS,
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
  /** The claims of every kind (GET /claims lists them, GET /holiday-work the Sunday / holiday ones). */
  claims: CompensationClaim[];
  /** The switches (and, from a newer server, `raiseProblem`: why HR cannot raise) every holiday-work answer carries. */
  holidayEnabled: HolidayWorkEnabled;
  eligible: Record<string, HolidayWorkEligibleResponse>;
  /** The Raise strip: the Sundays and holidays of a month, by "YYYY-MM". */
  monthDays: Record<string, HolidayWorkMonthDay[]>;
  balances: BalanceListRow[];
  ledgers: Record<number, BalanceDetail>;
  /** Every credit and debit (Credits). */
  ledger: LedgerRow[];
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

/** One page of a list (`page` / `pageSize` of the request, 25 by default), under the list's own key names. */
function pageOfRows<T>(rows: T[], qs: URLSearchParams, list: string, count: string): Record<string, unknown> {
  const page = Math.max(1, Number(qs.get("page") ?? 1) || 1);
  const pageSize = Math.max(1, Number(qs.get("pageSize") ?? 25) || 25);
  return { [list]: rows.slice((page - 1) * pageSize, page * pageSize), [count]: rows.length, page, pageSize };
}

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
    eligible: {
      [SUNDAY]: copy(ELIGIBLE_SUNDAY),
      "2026-10-04": copy(ELIGIBLE_FIRST_SUNDAY),
      "2026-10-13": copy(ELIGIBLE_WEEKDAY),
    },
    monthDays: copy(MONTH_DAYS),
    balances: copy(BALANCES),
    ledgers: copy(LEDGERS),
    ledger: copy(LEDGER),
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
        // the list's filters (month, kind, today-and-upcoming / past, department, branch, reason or who) and paging
        const kind = qs.get("kind");
        const status = qs.get("status");
        const month = qs.get("month");
        const year = qs.get("year");
        const q = (qs.get("q") ?? "").toLowerCase();
        const matching = world.windows.filter(
          (w) =>
            (!kind || kind === "all" || w.kind === kind) &&
            (!month || Number(w.date.slice(5, 7)) === Number(month)) &&
            (!year || w.date.startsWith(year)) &&
            (!status || (status === "upcoming" ? w.date >= TODAY : w.date < TODAY)) &&
            (!qs.get("departmentId") || String(w.departmentId) === qs.get("departmentId")) &&
            (!qs.get("branchId") || String(w.branchId) === qs.get("branchId")) &&
            (!q || `${w.reason ?? ""} ${w.announcedBy ?? ""}`.toLowerCase().includes(q)),
        );
        return copy({
          ...pageOfRows(matching, qs, "results", "count"),
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
        const results = world.claims.filter(
          (c) => c.kind === "holiday_work" && (!status || status === "all" || c.status === status),
        );
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
          } as CompensationClaim;
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
        const q = (qs.get("q") ?? "").toLowerCase();
        const matching = world.balances.filter(
          (b) =>
            (!qs.get("departmentId") || String(b.departmentId) === qs.get("departmentId")) &&
            (!qs.get("branchId") || String(b.branchId) === qs.get("branchId")) &&
            (!q || `${b.employeeName} ${b.employeeCode}`.toLowerCase().includes(q)),
        );
        const total = (key: "earned" | "used" | "pending" | "available") =>
          Math.round(matching.reduce((t, b) => t + b[key], 0) * 100) / 100;
        return copy({
          ...pageOfRows(matching, qs, "items", "total"),
          summary: {
            employees: matching.filter((b) => b.available > 0).length,
            earned: total("earned"),
            used: total("used"),
            pending: total("pending"),
            available: total("available"),
          },
        });
      }
      case GET && path === "/api/compensation/credits":
        return { results: copy(world.credits), count: world.credits.length };
      case GET && path === "/api/compensation/birthdays":
        return birthdaysOf(
          (qs.get("period") ?? "today") as "today",
          qs.get("date") ?? TODAY,
          world.birthdayEnabled,
          qs,
        );
      case GET && path === "/api/compensation/reports":
        return copy(world.report(qs));
      // ── the claim workflow (Compensation Leave B) ──
      case GET && path === "/api/compensation/claims": {
        const month = qs.get("month");
        const year = qs.get("year");
        const q = (qs.get("q") ?? "").toLowerCase();
        // everything but the status and the kind: the tiles count by those
        const scoped = world.claims.filter(
          (c) =>
            (qs.get("anyMonth") || !month || Number(c.workDate.slice(5, 7)) === Number(month)) &&
            (qs.get("anyMonth") || !year || c.workDate.startsWith(year)) &&
            (!qs.get("employeeId") || String(c.employeeId) === qs.get("employeeId")) &&
            (!qs.get("departmentId") || String(c.departmentId) === qs.get("departmentId")) &&
            (!qs.get("branchId") || String(c.branchId) === qs.get("branchId")) &&
            (!qs.get("raisedBy") || c.raisedByRole === qs.get("raisedBy")) &&
            (!q || `${c.employeeName} ${c.employeeCode}`.toLowerCase().includes(q)),
        );
        const count = (key: (c: CompensationClaim) => string) =>
          scoped.reduce<Record<string, number>>((acc, c) => ({ ...acc, [key(c)]: (acc[key(c)] ?? 0) + 1 }), {});
        const shiftsOf = (status: string) =>
          scoped.filter((c) => c.status === status).reduce((t, c) => t + c.shifts, 0);
        const matching = scoped.filter(
          (c) => (!qs.get("status") || c.status === qs.get("status")) && (!qs.get("kind") || c.kind === qs.get("kind")),
        );
        return copy({
          ...pageOfRows(matching, qs, "items", "total"),
          summary: {
            byStatus: count((c) => c.status),
            byKind: count((c) => c.kind),
            pendingShifts: shiftsOf("pending"),
            approvedShifts: shiftsOf("approved"),
            // the review fix: what waits, split into credits (in) and days off (out)
            pendingCreditShifts: scoped
              .filter((c) => c.status === "pending" && c.kind !== "use_balance")
              .reduce((t, c) => t + c.shifts, 0),
            pendingUseShifts: scoped
              .filter((c) => c.status === "pending" && c.kind === "use_balance")
              .reduce((t, c) => t + c.shifts, 0),
          },
          enabled: world.holidayEnabled,
        });
      }
      case method === "POST" && path === "/api/compensation/claims": {
        // HR claims for employees: every item goes through, waiting for the Department Head
        const made = ((body.items ?? []) as { employeeId: number; shifts?: number; overtimeRecordId?: number }[]).map(
          (item, i) =>
            ({
              ...copy(CLAIMS[0]),
              id: 3200 + world.claims.length + i,
              employeeId: item.employeeId,
              employeeCode: `E${item.employeeId}`,
              employeeName: `Employee ${item.employeeId}`,
              kind: body.kind,
              workDate: String(body.date),
              shifts: item.shifts ?? 1,
              overtimeRecordId: item.overtimeRecordId ?? null,
              reason: String(body.reason),
            }) as CompensationClaim,
        );
        world.claims.unshift(...made);
        return { created: made.length, warnings: [], claims: made };
      }
      case method === "DELETE" && /^\/api\/compensation\/claims\/\d+$/.test(path): {
        const id = Number(path.split("/").pop());
        world.claims = world.claims.filter((c) => c.id !== id);
        return null;
      }
      case method === "POST" && path === "/api/compensation/use": {
        const made = {
          ...copy(CLAIMS[0]),
          id: 3300 + world.claims.length,
          employeeId: Number(body.employeeId),
          kind: "use_balance",
          workDate: String(body.date),
          useDate: String(body.date),
          shifts: Number(body.shifts),
          reason: String(body.reason),
        } as CompensationClaim;
        world.claims.unshift(made);
        const row = world.balances.find((b) => b.employeeId === made.employeeId);
        if (row) {
          row.pending += made.shifts;
          row.available -= made.shifts;
        }
        return made;
      }
      case GET && path === "/api/compensation/ledger": {
        const month = qs.get("month");
        const year = qs.get("year");
        const q = (qs.get("q") ?? "").toLowerCase();
        const matching = world.ledger.filter(
          (r) =>
            (!qs.get("entryType") || r.type === qs.get("entryType")) &&
            (!qs.get("source") || r.source === qs.get("source")) &&
            (!month || Number(r.date.slice(5, 7)) === Number(month)) &&
            (!year || r.date.startsWith(year)) &&
            (!qs.get("employeeId") || String(r.employeeId) === qs.get("employeeId")) &&
            (!qs.get("departmentId") || String(r.departmentId) === qs.get("departmentId")) &&
            (!qs.get("branchId") || String(r.branchId) === qs.get("branchId")) &&
            (!q || `${r.employeeName} ${r.employeeCode}`.toLowerCase().includes(q)),
        );
        return copy(pageOfRows(matching, qs, "items", "total"));
      }
      case GET && path === "/api/compensation/holiday-work/month": {
        const key = `${qs.get("year")}-${String(qs.get("month")).padStart(2, "0")}`;
        return copy({ days: world.monthDays[key] ?? [], defaultDate: SUNDAY, maxAgeDays: 45 });
      }
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
/** The labels (with their counts) of a strip of nested subtabs, `<testId>` being the strip's wrapper (`leave-holiday-nested`). */
export const nestedLabels = (testId: string): string[] =>
  [...document.body.querySelectorAll(`[data-testid="${testId}-strip"] [role="tab"]`)].map((t) => text(t));

/** One tab of a strip of nested subtabs, by its value. */
export const nestedTab = (testId: string, value: string): HTMLElement =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}-${value}"]`)!;

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
