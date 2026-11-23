import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MissedBankCheck,
  MissedEntry,
  MissedRow,
  MissedStatus,
} from "@/lib/api-client/custom-hooks/missed-payroll";
import MissedPayroll from "../MissedPayroll";
import { todayIso } from "./logic";

// The Missed Payroll page in jsdom against a fake /api/missed-payroll server (the real hooks and fetch layer): the views
// and their pills, Generate in batches of 20 with the skipped list, Clear, Done behind its dialog with the server's
// refusals on the page, Paid with its day, a unit login, Not cleared (check only), the bank check before the bank file,
// the figures sheet, the attendance sheet, and the Production tab.

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  saved: vi.fn(),
  user: { role: "hr", employeeId: null, isSuperAdmin: true } as Record<string, unknown>,
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/exportUtils", async (original) => ({
  ...(await original<typeof import("@/lib/exportUtils")>()),
  downloadBlob: (blob: Blob, name: string) => h.saved(blob, name),
}));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: h.user }),
}));
// the attendance editor is the HRMS's own (tested with Payroll Details): here only where it is put and what it is given
vi.mock("@/pages/hr/payroll-details/DayAttendanceEdit", () => ({
  DayAttendanceEdit: ({ employeeId, date }: { employeeId: number; date: string }) =>
    createElement("div", { "data-testid": "stub-day-edit" }, `edit ${employeeId} ${date}`),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

// ── the fake server ──────────────────────────────────────────────────────────

let nextEntryId = 500;

const entry = (status: MissedStatus, over: Partial<MissedEntry> = {}): MissedEntry => ({
  id: nextEntryId++,
  status,
  category: "not_generated",
  gross: 24000,
  deductions: 900,
  net: 23100,
  payRanges: [],
  payDays: 0,
  replacesPayrollId: null,
  payrollId: status === "done" || status === "paid" ? 77 : null,
  generatedAt: "2026-11-23T10:00:00+05:30",
  generatedBy: "Admin",
  clearedAt: null,
  clearedBy: null,
  doneAt: null,
  doneBy: null,
  paidAt: null,
  paidBy: null,
  paidOn: status === "paid" ? "2026-11-22" : null,
  ...over,
});

const emp = (id: number, over: Partial<MissedRow> = {}): MissedRow => ({
  id,
  code: String(30000 + id),
  name: `EMPLOYEE ${id}`,
  status: "active",
  departmentId: 3,
  department: "ACCOUNTS",
  designationId: 5,
  designation: "ACCOUNTANT",
  branchId: 1,
  unit: "Head Office",
  joinDate: "2024-01-10",
  salary: 25000,
  payCycle: null,
  bankIssue: null,
  category: "not_generated",
  categoryLabel: "Not generated",
  reason: "No payroll for November 2026: never generated for this employee, or skipped by the payroll.",
  detail: null,
  payroll: null,
  entry: null,
  canGenerate: true,
  cannotGenerate: null,
  payDays: null,
  ...over,
});

const staffRows = (): MissedRow[] => [
  emp(1, { name: "SURYA M" }),
  emp(2, {
    name: "NO RATE",
    category: "no_salary",
    categoryLabel: "Salary not fixed",
    salary: null,
    canGenerate: false,
    cannotGenerate: "Set the salary on the employee's profile first.",
    reason: "No monthly salary on the profile (salary not fixed): the payroll could not work it out.",
  }),
  emp(3, {
    name: "MEENA R",
    category: "on_hold",
    categoryLabel: "On hold",
    reason: "Salary on hold for November 2026 on the Staff Payroll.",
    detail: "Held by Admin.",
    entry: entry("generated", { category: "on_hold" }),
  }),
  emp(4, {
    name: "NEW PERSON",
    category: "new_joiner",
    categoryLabel: "New joiners",
    entry: entry("cleared", { category: "new_joiner" }),
    canGenerate: false,
    cannotGenerate: "Cleared: undo Clear to work it out again.",
  }),
  emp(5, {
    name: "OLD HAND",
    status: "inactive",
    category: "inactive",
    categoryLabel: "Inactive",
    reason: "Inactive employee: the payroll leaves inactive employees out.",
  }),
  emp(6, {
    name: "CHECK ME",
    category: "not_cleared",
    categoryLabel: "Not cleared",
    canGenerate: false,
    cannotGenerate: "Already in the month's payroll: mark it Cleared on its Payroll Details page.",
    payroll: {
      id: 41,
      net: 20000,
      cleared: false,
      onHold: false,
      newJoinerParked: false,
      paymentStatus: "unpaid",
      periodStart: null,
      periodEnd: null,
      payCycle: null,
      source: null,
    },
  }),
  emp(7, { name: "DONE ONE", entry: entry("done"), canGenerate: false, cannotGenerate: "Done." }),
  emp(8, { name: "PAID ONE", entry: entry("paid"), canGenerate: false, cannotGenerate: "Paid." }),
  // 25 more not generated: 27 in all can be generated in Missed (1, 3 and these)
  ...Array.from({ length: 25 }, (_, i) => emp(100 + i)),
];

const productionRows = (): MissedRow[] => [
  emp(201, {
    name: "WORKER ONE",
    department: "STITCHING",
    salary: 650,
    payCycle: "weekly",
    reason: "Worked days of November 2026 that no payroll pays yet (Weekly cycle).",
    canGenerate: false,
    cannotGenerate: "November 2026 has not ended yet: production pay is worked out once the month is over.",
    payDays: {
      ranges: [["2026-11-17", "2026-11-30"]],
      text: "17 Nov - 30 Nov",
      days: 14,
      worked: 5,
    },
  }),
];

type Call = { method: string; path: string; params: URLSearchParams; body: Record<string, unknown> | undefined };

const server = {
  rows: [] as MissedRow[],
  canEdit: true,
  wholeCompany: true,
  /** Refuse Done for these employee ids, with the server's reason. */
  refuseDone: new Set<number>(),
  calls: [] as Call[],
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const file = (name: string) =>
  new Response(new Blob(["PK"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${name}"`,
    },
  });

function summary(rows: MissedRow[]) {
  const byCategory: Record<string, number> = {
    not_generated: 0,
    no_salary: 0,
    on_hold: 0,
    new_joiner: 0,
    not_cleared: 0,
    inactive: 0,
  };
  const byStatus: Record<string, number> = { generated: 0, cleared: 0, done: 0, paid: 0 };
  const netByStatus: Record<string, number> = { generated: 0, cleared: 0, done: 0, paid: 0 };
  for (const r of rows) {
    byCategory[r.category] += 1;
    if (r.entry) {
      byStatus[r.entry.status] += 1;
      netByStatus[r.entry.status] += r.entry.net ?? 0;
    }
  }
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    inactive: rows.filter((r) => r.status !== "active").length,
    byCategory,
    byStatus,
    netByStatus,
  };
}

const who = (r: MissedRow) => ({ employeeId: r.id, employeeCode: r.code, name: r.name });

function step(ids: number[], from: MissedStatus, to: MissedStatus | null, reason: string) {
  const done: number[] = [];
  const refused: unknown[] = [];
  for (const id of ids) {
    const r = server.rows.find((x) => x.id === id)!;
    if (r.entry?.status !== from) {
      refused.push({ ...who(r), reason });
      continue;
    }
    done.push(r.entry.id);
    if (to === null) {
      r.entry = null;
      r.canGenerate = true;
    } else {
      r.entry = { ...r.entry, status: to };
      r.canGenerate = to === "generated";
    }
  }
  return { done, refused };
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  server.calls.push({ method, path: url.pathname, params: url.searchParams, body });
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number);
  const byId = (id: number) => server.rows.find((e) => e.id === id)!;
  const kind = url.searchParams.get("kind") ?? "staff";

  switch (url.pathname) {
    case "/api/missed-payroll/employees":
      if (kind === "production") server.rows = productionRows();
      return json({
        kind,
        month: 11,
        year: 2026,
        periodLabel: "November 2026",
        monthStart: "2026-11-01",
        monthEnd: "2026-11-30",
        monthStarted: true,
        monthEnded: false,
        mainGenerated: true,
        mainFinalized: kind === "staff",
        mainPaid: false,
        canEdit: server.canEdit,
        wholeCompany: server.wholeCompany,
        summary: summary(server.rows),
        categories: [
          { value: "not_generated", label: "Not generated" },
          { value: "no_salary", label: "Salary not fixed" },
          { value: "on_hold", label: "On hold" },
          { value: "new_joiner", label: "New joiners" },
          { value: "not_cleared", label: "Not cleared" },
          { value: "inactive", label: "Inactive" },
        ],
        departments: [{ id: 3, name: "ACCOUNTS" }],
        units: [{ id: 1, name: "Head Office" }],
        employees: server.rows,
      });
    case "/api/missed-payroll/generate": {
      const generated: unknown[] = [];
      const skipped: unknown[] = [];
      for (const id of body!.employeeIds as number[]) {
        const r = byId(id);
        if (id === 124) {
          skipped.push({ ...who(r), reason: "No attendance in November 2026." });
          continue;
        }
        r.entry = entry("generated", { category: r.category, net: 20000 });
        generated.push({ ...who(r), entryId: r.entry.id, net: 20000, gross: 21000 });
      }
      return json({ generated, skipped });
    }
    case "/api/missed-payroll/clear":
      return json(
        step(body!.employeeIds as number[], "generated", "cleared", "Only a generated payroll can be cleared."),
      );
    case "/api/missed-payroll/unclear":
      return json(step(body!.employeeIds as number[], "cleared", "generated", "Only a cleared payroll can go back."));
    case "/api/missed-payroll/discard":
      return json(step(body!.employeeIds as number[], "generated", null, "Only a generated payroll can be removed."));
    case "/api/missed-payroll/done": {
      if (!server.wholeCompany) return json({ error: "Only a login for all units can do it." }, 403);
      const asked = body!.employeeIds as number[];
      const refusedHere = asked.filter((id) => server.refuseDone.has(id));
      const out = step(
        asked.filter((id) => !server.refuseDone.has(id)),
        "cleared",
        "done",
        "Clear it first: only a cleared payroll can be Done.",
      );
      return json({
        done: out.done.map((id) => ({ entryId: id })),
        refused: [
          ...out.refused,
          ...refusedHere.map((id) => ({
            ...who(byId(id)),
            reason: "The Staff Payroll made a row for this employee meanwhile: refresh.",
          })),
        ],
      });
    }
    case "/api/missed-payroll/paid": {
      const out = step(body!.employeeIds as number[], "done", "paid", "Only a payroll marked Done can be marked paid.");
      return json({ done: out.done.map((id) => ({ entryId: id })), refused: out.refused, notified: out.done.length });
    }
    case "/api/missed-payroll/entry": {
      const id = Number(url.searchParams.get("id"));
      const r = server.rows.find((x) => x.entry?.id === id)!;
      return json({
        entry: r.entry,
        employee: { id: r.id, code: r.code, name: r.name },
        kind: "staff",
        month: 11,
        year: 2026,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
        earnings: [
          {
            key: "gross",
            label: "Salary earned",
            note: "₹25,000 / 30 days x 28 days paid",
            amount: 23333.33,
            kind: "earning",
          },
        ],
        deductions: [{ key: "pf", label: "PF (12%)", note: null, amount: 900, kind: "deduction" }],
        statement: { present: 26, net: 23100, remarks: "MISSED PAYROLL", status: "GENERATED", category: "ON HOLD" },
        summary: {},
        days: [{ date: "2026-11-02", day: "Mon", status: "present", firstIn: "08:58", lastOut: "18:02" }],
        notes: null,
      });
    }
    case "/api/missed-payroll/bank-check": {
      const check: MissedBankCheck = { included: [], total: 0, leftOut: [] };
      for (const id of ids) {
        const r = byId(id);
        if (r.entry?.status === "done") {
          check.included.push({ employeeId: id, code: r.code, name: r.name, amount: r.entry.net ?? 0 });
          check.total += r.entry.net ?? 0;
        } else {
          check.leftOut.push({
            employeeId: id,
            code: r.code,
            name: r.name,
            reason: "Not Done yet: only a payroll marked Done is paid",
          });
        }
      }
      return json(check);
    }
    case "/api/missed-payroll/download/bank-file":
      return file("Missed-Payroll-Staff-November-2026-Bank-File.xlsx");
    case "/api/missed-payroll/download/report":
      return file("Missed-Payroll-Staff-November-2026.xlsx");
    case "/api/attendance/employee-monthly":
      return json({
        employee: { id: 1, code: url.searchParams.get("code"), name: "SURYA M" },
        assignedShift: null,
        month: 11,
        year: 2026,
        attendanceMode: "strict",
        weeks: [
          {
            week: 1,
            days: [
              {
                date: "2026-11-02",
                day: "Mon",
                status: "present",
                isLate: false,
                isHalfShift: false,
                earlyLeave: false,
                shiftsEarned: "1.00",
                firstPunch: "08:58",
                lastPunch: "18:02",
                totalPunches: 2,
                source: "auto",
              },
              {
                date: "2026-11-03",
                day: "Tue",
                status: "absent",
                isLate: false,
                isHalfShift: false,
                earlyLeave: false,
                shiftsEarned: "0.00",
                totalPunches: 0,
                source: "auto",
              },
            ],
          },
        ],
        summary: {
          totalDays: 2,
          workingDays: 2,
          present: 1,
          halfShift: 0,
          absent: 1,
          onLeave: 0,
          holidays: 0,
          late: 0,
          totalShifts: "1.00",
          effectiveDays: "1.00",
        },
      });
    default:
      return json({ error: `no fake for ${url.pathname}` }, 500);
  }
}

// ── the page ─────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  nextEntryId = 500;
  server.rows = staffRows();
  server.canEdit = true;
  server.wholeCompany = true;
  server.refuseDone = new Set();
  server.calls = [];
  h.user = { role: "hr", employeeId: null, isSuperAdmin: true };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  window.history.replaceState(null, "", "/hr/missed-payroll?month=11&year=2026");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(MissedPayroll))));
  await waitFor(() => q("mp-table") !== null || q("mp-empty") !== null, "the list");
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
async function waitFor(check: () => boolean, label = "the condition") {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await settle(5);
  }
  throw new Error(`timed out waiting for ${label}; the page shows: ${text(document.body).slice(0, 600)}`);
}
const calls = (path: string, method = "GET") =>
  server.calls.filter((c) => c.path === `/api/missed-payroll/${path}` && c.method === method);
const tick = (code: string) => click(must(`mp-select-${code}`));
const view = (v: string) => click(must(`mp-view-${v}`).closest("button"));
const isDisabled = (id: string) => (must(id) as HTMLButtonElement).disabled;

describe("the Missed Payroll page", () => {
  it("lists the active employees the payroll missed, with the reasons, counts and the month's banners", async () => {
    await mount();
    expect(calls("employees")[0].params.get("kind")).toBe("staff");
    expect(text(must("mp-view-missed"))).toBe("Missed (31)");
    expect(text(must("mp-view-inactive"))).toBe("Inactive (1)");
    expect(text(must("mp-view-not_cleared"))).toBe("Not cleared (1)");
    expect(text(must("mp-view-processed"))).toBe("Processed (4)");
    expect(text(must("mp-cat-no_salary"))).toBe("Salary not fixed (1)");
    expect(text(must("mp-cat-on_hold"))).toBe("On hold (1)");
    // inactive and not-cleared employees are never in the Missed list
    expect(q("mp-row-30005")).toBeNull();
    expect(q("mp-row-30006")).toBeNull();
    expect(text(must("mp-row-30003"))).toContain("Held by Admin.");
    expect(text(must("mp-row-30003"))).toContain("Generated");
    expect(text(must("mp-row-30002"))).toContain("Not set");
    expect(must("mp-set-salary-30002").getAttribute("href")).toBe("/hr/employees/2/edit");
    expect(text(must("mp-banner-finalized"))).toContain("Done here still adds to it");
    expect(text(must("mp-banner-not-ended"))).toContain("November 2026 is not over yet");
    expect(text(must("mp-kpi-done"))).toContain("₹23,100");

    click(must("mp-cat-on_hold"));
    await waitFor(() => q("mp-row-30001") === null, "the on-hold pill");
    expect(q("mp-row-30003")).not.toBeNull();
    expect(window.location.search).toContain("cat=on_hold");
  });

  it("keeps inactive employees in their own view, and Not cleared only to check", async () => {
    await mount();
    view("inactive");
    await waitFor(() => q("mp-row-30005") !== null, "the inactive row");
    expect(q("mp-row-30001")).toBeNull();
    expect(text(must("mp-row-30005"))).toContain("INACTIVE");

    view("not_cleared");
    await waitFor(() => q("mp-row-30006") !== null, "the not-cleared row");
    expect(q("mp-select-all")).toBeNull();
    expect(q("mp-select-30006")).toBeNull();
    expect(must("mp-open-payroll-30006").getAttribute("href")).toBe("/hr/payroll/details/41");
    expect(text(must("mp-not-cleared-note"))).toContain("would pay them twice");
    expect(window.location.search).toContain("view=not_cleared");
  });

  it("generates the ticked employees in batches of 20 and lists who could not be worked out", async () => {
    await mount();
    click(must("mp-select-all"));
    expect(text(must("mp-selected-count"))).toBe("31 selected");
    expect(text(must("mp-bulk-generate"))).toBe("Generate (27)");
    click(must("mp-bulk-generate"));
    await waitFor(() => calls("generate", "POST").length === 2 && q("mp-progress") === null, "the run");
    const batches = calls("generate", "POST").map((c) => (c.body!.employeeIds as number[]).length);
    expect(batches).toEqual([20, 7]);
    expect(calls("generate", "POST")[0].body).toMatchObject({ kind: "staff", month: 11, year: 2026 });
    // the no-salary one was never sent
    expect(calls("generate", "POST").flatMap((c) => c.body!.employeeIds as number[])).not.toContain(2);
    await waitFor(() => q("mp-result") !== null, "the skipped list");
    expect(text(must("mp-result"))).toContain("No attendance in November 2026.");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "26 employees generated for November 2026" }),
    );
    await waitFor(() => text(q("mp-row-30001")).includes("₹20,000"), "the refreshed row");
  });

  it("clears, then adds to the payroll behind the Done dialog, showing the server's refusals", async () => {
    await mount();
    tick("30003");
    tick("30004");
    expect(text(must("mp-bulk-clear"))).toBe("Clear (1)");
    click(must("mp-bulk-clear"));
    await waitFor(() => calls("clear", "POST").length === 1, "the clear");
    expect(calls("clear", "POST")[0].body!.employeeIds).toEqual([3]);
    await waitFor(() => text(must("mp-bulk-done")) === "Done (2)", "both cleared");

    server.refuseDone = new Set([4]);
    click(must("mp-bulk-done"));
    expect(text(must("mp-done-dialog"))).toContain("Add 2 employees to the November 2026 payroll?");
    expect(text(must("mp-done-dialog"))).toContain("cannot be undone here");
    expect(text(must("mp-done-dialog"))).toContain("bank file here, then mark them Paid here");
    expect(calls("done", "POST")).toHaveLength(0);
    click(must("mp-done-confirm"));
    await waitFor(() => calls("done", "POST").length === 1, "the done");
    expect(calls("done", "POST")[0].body!.employeeIds).toEqual([3, 4]);
    await waitFor(() => q("mp-result") !== null, "the refusals");
    expect(text(must("mp-result"))).toContain("1 employee not added to the payroll");
    expect(text(must("mp-result"))).toContain("made a row for this employee meanwhile");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "1 employee added to the November 2026 payroll (Done)" }),
    );
  });

  it("marks Done employees paid on the day picked, never a future one", async () => {
    await mount();
    tick("30007");
    tick("30001");
    expect(text(must("mp-bulk-paid"))).toBe("Paid (1)");
    click(must("mp-bulk-paid"));
    expect(text(must("mp-paid-dialog"))).toContain("Each employee gets the salary-paid notification once.");
    const input = must("mp-paid-on") as HTMLInputElement;
    expect(input.value).toBe(todayIso());
    const setValue = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    setValue("2999-01-01");
    expect(text(must("mp-paid-on-help"))).toContain("cannot be in the future");
    expect(isDisabled("mp-paid-confirm")).toBe(true);
    const yesterday = todayIso(new Date(Date.now() - 86_400_000));
    setValue(yesterday);
    click(must("mp-paid-confirm"));
    await waitFor(() => calls("paid", "POST").length === 1, "the paid");
    expect(calls("paid", "POST")[0].body).toEqual({
      kind: "staff",
      month: 11,
      year: 2026,
      employeeIds: [7],
      paidOn: yesterday,
    });
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "1 employee marked paid",
        description: "1 salary-paid notification on the way",
      }),
    );
  });

  it("a login for one unit can generate and clear, but not Done or Paid", async () => {
    server.wholeCompany = false;
    await mount();
    expect(text(must("mp-banner-unit"))).toContain("only a login for all units");
    tick("30004");
    tick("30007");
    tick("30003");
    expect(isDisabled("mp-bulk-done")).toBe(true);
    expect(isDisabled("mp-bulk-paid")).toBe(true);
    expect(isDisabled("mp-bulk-clear")).toBe(false);
    expect(isDisabled("mp-bulk-generate")).toBe(false);
    expect(must("mp-bulk-done").getAttribute("aria-label")).toContain("only a login for all units");
  });

  it("checks who the bank file pays before downloading it", async () => {
    await mount();
    tick("30007");
    tick("30003");
    press(must("mp-bulk-files"), "Enter");
    click(must("mp-bulk-files-bank"));
    await waitFor(() => q("mp-bank-review") !== null, "the bank check");
    expect(calls("bank-check")[0].params.get("ids")).toBe("3,7");
    expect(text(must("mp-bank-included"))).toContain("1 employee will be paid by bank transfer");
    expect(text(must("mp-bank-left-out"))).toContain("Not Done yet");
    expect(h.saved).not.toHaveBeenCalled();
    click(must("mp-bank-confirm"));
    await waitFor(() => h.saved.mock.calls.length === 1, "the bank file");
    expect(calls("download/bank-file")[0].params.get("ids")).toBe("7");
    expect(h.saved.mock.calls[0][1]).toBe("Missed-Payroll-Staff-November-2026-Bank-File.xlsx");
  });

  it("downloads the payroll report of the listed employees with figures", async () => {
    await mount();
    press(must("mp-view-files"), "Enter");
    click(must("mp-view-files-report"));
    await waitFor(() => h.saved.mock.calls.length === 1, "the report");
    // only those with an entry: 3, 4, 7 and 8 of the Missed list
    expect(calls("download/report")[0].params.get("ids")).toBe("3,4,7,8");
    expect(calls("download/report")[0].params.get("kind")).toBe("staff");
  });

  it("shows an entry's figures in a sheet", async () => {
    await mount();
    click(must("mp-figures-30003"));
    await waitFor(() => q("mp-figures-body") !== null, "the figures");
    expect(text(must("mp-figures-earnings"))).toContain("Salary earned");
    expect(text(must("mp-figures-deductions"))).toContain("PF (12%)");
    expect(text(must("mp-figures-total-net"))).toContain("₹23,100");
    expect(text(must("mp-figures-statement"))).toContain("MISSED PAYROLL");
    expect(q("mp-figures-generate")).not.toBeNull();
  });

  it("opens the month's attendance in the page and the HRMS's editor for a picked day", async () => {
    await mount();
    click(must("mp-attendance-30003"));
    await waitFor(() => q("mp-calendar") !== null, "the calendar");
    const asked = server.calls.find((c) => c.path === "/api/attendance/employee-monthly")!;
    expect(asked.params.get("code")).toBe("30003");
    expect(asked.params.get("month")).toBe("11");
    expect(text(must("mp-attendance-note"))).toContain("Department Head approves it first, then HR");
    expect(text(must("mp-attendance-regenerate"))).toContain("press Generate again");
    click(must("mp-day-2026-11-03"));
    expect(text(must("stub-day-edit"))).toBe("edit 3 2026-11-03");
  });

  it("opens the Production tab from the address, with the days no payroll pays", async () => {
    window.history.replaceState(null, "", "/hr/missed-payroll?month=11&year=2026&tab=production");
    await mount();
    expect(calls("employees")[0].params.get("kind")).toBe("production");
    expect(text(must("mp-table"))).toContain("Days to pay");
    expect(text(must("mp-row-30201"))).toContain("17 Nov - 30 Nov");
    expect(text(must("mp-row-30201"))).toContain("14 days · worked 5");
    expect(text(must("mp-row-30201"))).toContain("/ shift");
    expect(text(must("mp-banner-not-ended"))).toContain("production pay is worked out only once the month has ended");
    expect(q("mp-banner-finalized")).toBeNull();
  });

  it("a view-only login can look and download, but not change anything", async () => {
    h.user = { role: "hr", employeeId: null, permissions: { missed_payroll: "view" } };
    server.canEdit = false;
    await mount();
    expect(q("mp-generate-30001")).toBeNull();
    tick("30003");
    expect(isDisabled("mp-bulk-generate")).toBe(true);
    expect(isDisabled("mp-bulk-clear")).toBe(true);
    expect(must("mp-bulk-clear").getAttribute("aria-label")).toContain("Needs edit rights");
    expect(isDisabled("mp-bulk-files")).toBe(false);
  });
});
